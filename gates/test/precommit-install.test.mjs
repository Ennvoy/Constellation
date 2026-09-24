// gates/test/precommit-install.test.mjs — P16 回歸：pre-commit 兜底安裝改成單支
// `git rev-parse --git-common-dir --git-path hooks`（原本 3 支），且 hooksPath 判斷改成路徑比對
// （resolve 後相等即視為標準位置）——hooksPath 剛好設成同一個目錄（不論相對或絕對寫法）時應該正常
// 安裝，不再像舊版一樣只要 core.hooksPath 有設值就一律跳過。installPrecommit 是純函式、無自動執行，
// 直接 import 呼叫。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { installPrecommit } from '../precommit-install.mjs';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
}
function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pci-'));
  git(dir, ['init', '-q']);
  return dir;
}

let dirs = [];
function repo() {
  const d = initRepo();
  dirs.push(d);
  return d;
}

after(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

describe('precommit-install：P16——單支 git 呼叫、冪等、hooksPath 路徑比對', () => {
  test('全新 repo：首次安裝回報 installed，再裝一次回報 alreadyInstalled（冪等）', () => {
    const cwd = repo();
    const r1 = installPrecommit(cwd);
    assert.equal(r1.installed, true, JSON.stringify(r1));
    const content = readFileSync(join(cwd, '.git', 'hooks', 'pre-commit'), 'utf8');
    assert.match(content, /commit-gate\.mjs/);
    assert.match(content, /--precommit/);

    const r2 = installPrecommit(cwd);
    assert.equal(r2.alreadyInstalled, true, JSON.stringify(r2));
  });

  test('非 git 目錄：回報 skipped=not-git，不寫任何檔案', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pci-nogit-'));
    dirs.push(dir);
    const r = installPrecommit(dir);
    assert.equal(r.skipped, 'not-git');
  });

  test('core.hooksPath 設成別的目錄（如 .husky）：回報 skipped=custom-hookspath，附警告', () => {
    const cwd = repo();
    mkdirSync(join(cwd, '.husky'), { recursive: true });
    git(cwd, ['config', 'core.hooksPath', '.husky']);
    const r = installPrecommit(cwd);
    assert.equal(r.skipped, 'custom-hookspath');
    assert.match(r.warn, /husky|core\.hooksPath/);
  });

  test('core.hooksPath 剛好設成同一個目錄的相對寫法（.git/hooks）：改後應正常安裝，不當成自訂改向', () => {
    const cwd = repo();
    git(cwd, ['config', 'core.hooksPath', '.git/hooks']);
    const r = installPrecommit(cwd);
    assert.equal(r.installed, true, `應安裝，實際 ${JSON.stringify(r)}`);
  });

  test('core.hooksPath 設成同一個目錄的絕對路徑寫法：改後應正常安裝', () => {
    const cwd = repo();
    const abs = resolve(cwd, '.git', 'hooks').replace(/\\/g, '/');
    git(cwd, ['config', 'core.hooksPath', abs]);
    const r = installPrecommit(cwd);
    assert.equal(r.installed, true, `應安裝，實際 ${JSON.stringify(r)}`);
  });

  test('既有 pre-commit 是非 sh 直譯器（python）：回報 skipped=foreign-interpreter，不動原檔', () => {
    const cwd = repo();
    const hooksDir = join(cwd, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const original = '#!/usr/bin/env python3\nprint("custom hook")\n';
    writeFileSync(join(hooksDir, 'pre-commit'), original, 'utf8');
    const r = installPrecommit(cwd);
    assert.equal(r.skipped, 'foreign-interpreter');
    assert.equal(readFileSync(join(hooksDir, 'pre-commit'), 'utf8'), original);
  });

  test('既有 sh pre-commit（別人寫的內容）：用 append、不 clobber 原內容', () => {
    const cwd = repo();
    const hooksDir = join(cwd, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const original = '#!/bin/sh\necho "existing check"\n';
    writeFileSync(join(hooksDir, 'pre-commit'), original, 'utf8');
    const r = installPrecommit(cwd);
    assert.equal(r.installed, true);
    const after2 = readFileSync(join(hooksDir, 'pre-commit'), 'utf8');
    assert.match(after2, /existing check/);
    assert.match(after2, /commit-gate\.mjs/);
  });

  test('舊 Flow 死區塊會被清掉，換成 Constellation 自家區塊', () => {
    const cwd = repo();
    const hooksDir = join(cwd, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const legacy = '#!/bin/sh\n# >>> flow-gate (managed by flow-toolkit) >>>\n[ -f /old/flow-precommit.mjs ] && node /old/flow-precommit.mjs\n# <<< flow-gate <<<\n';
    writeFileSync(join(hooksDir, 'pre-commit'), legacy, 'utf8');
    const r = installPrecommit(cwd);
    assert.equal(r.installed, true);
    const after2 = readFileSync(join(hooksDir, 'pre-commit'), 'utf8');
    assert.doesNotMatch(after2, /flow-gate/);
    assert.match(after2, /commit-gate\.mjs/);
  });
});
