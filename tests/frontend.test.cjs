const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/static/app.js'), 'utf8');
// Exercise the shipped pure helpers without exposing application internals in
// the browser or loading an authenticated DOM.
const names = ['shiftDate', 'taskResultStatus', 'dailyChecklist', 'checkedTotal',
  'currentStreak', 'bestStreak', 'setProgressOutput'];
const helpers = names.map((name) => {
  const start = source.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `Missing helper: ${name}`);
  const end = source.indexOf('\n  function ', start + 1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}).join('\n');
const app = vm.runInNewContext(`${helpers}\n({${names.join(',')}})`, {
  dateKeyInShanghai: () => '2026-10-01',
});

test('unchecking a recorded complete plan immediately corrects streaks', () => {
  const yesterday = {date: '2026-09-30', done: true, resultStatus: 'completed', resultLocked: true};
  const today = {date: '2026-10-01', done: true, resultStatus: 'completed',
    resultIsStale: true, resultLocked: false,
    checklist: [{text: 'A', weight: 33}, {text: 'B', weight: 67}], checkedItems: [0]};
  assert.equal(app.taskResultStatus(today), 'incomplete');
  assert.equal(app.currentStreak([yesterday, today]), 1);
  assert.equal(app.bestStreak([yesterday, today]), 1);
  today.checkedItems = [0, 1];
  assert.equal(app.currentStreak([yesterday, today]), 2);
  assert.equal(app.bestStreak([yesterday, today]), 2);
});

test('supplemental checks cannot change a frozen incomplete result', () => {
  const task = {date: '2026-09-30', done: false, resultStatus: 'incomplete',
    resultLocked: true, resultIsStale: false,
    checklist: [{text: 'A', weight: 100}], checkedItems: [0]};
  assert.equal(app.taskResultStatus(task), 'incomplete');
  assert.equal(app.currentStreak([task]), 0);
  assert.equal(app.bestStreak([task]), 0);
});

test('an unrecorded full checklist stays pending until confirmed or frozen', () => {
  const task = {date: '2026-10-01', done: false, resultStatus: 'pending',
    resultLocked: false, checklist: [{text: 'A', weight: 100}], checkedItems: [0]};
  assert.equal(app.currentStreak([task]), 0);
  assert.equal(app.bestStreak([task]), 0);
});

test('percentage feedback distinguishes empty, partial and full progress', () => {
  for (const [percent, state] of [[0, 'empty'], [33, 'partial'], [99, 'partial'], [100, 'completed']]) {
    const output = {dataset: {}};
    app.setProgressOutput(output, percent);
    assert.equal(output.textContent, `${percent}%`);
    assert.equal(output.dataset.progressState, state);
  }
});
