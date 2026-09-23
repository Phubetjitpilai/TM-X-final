const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../../Frontend-react/node_modules/typescript');
const path = require('node:path');
function read(name) {
  return ts.createSourceFile(name, fs.readFileSync(path.join(__dirname,
    '../../Frontend-react/src/components/dashboard/', name), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const form = read('PartEntryModal.tsx');
const fields = read('EntryGroups.tsx');
function func(source, name) {
  let found;
  function visit(n) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
    ts.forEachChild(n, visit);
  }
  visit(source);
  return found.getText(source);
}
const constants = fields.statements.filter(n => ts.isVariableStatement(n) &&
  n.declarationList.declarations.some(d => ['GROUP_FIELDS', 'OPTIONAL_FIELDS', 'LOCKED_FIELDS'].includes(d.name.getText(fields))))
  .map(n => n.getText(fields).replace(/^export /, '')).join('\n');
const code = ts.transpileModule(constants + '\n' + func(form, 'parseAlplList').replace(/^export /, '') + '\n' +
  func(form, 'handleSave') + '\n' + func(fields, 'prefillGroup'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(mode, result) {
  const c = { mode, operator: 'Test', triggerMode: 'auto', trayCapacity: '', disabled: false,
    groups: [{ number_alpl: '10', package_size: '8x8', part_number: 'PN', po_number: '1',
      vendor: 'V', owner: 'O', description: 'Part', receive_date: '2026-09-23', handler: 'H' }],
    setTrayCapacityError() {}, setErrors() {}, setOperatorError() {}, setBusy() {}, focusFirstInvalid() {},
    onNotify() {}, apiPost: async () => result,
    confirmExisting: async ids => { c.existingPrompt = ids; return c.accept; },
    confirmRegister: async items => { c.registerPrompt = items; return c.accept; },
    onSave: q => { c.saved = q; }, accept: true, autoRef: { current: {} }, onOverwrite() {},
  };
  c.groupsRef = { current: c.groups };
  c.onChange = next => { c.groupsRef.current = next; };
  vm.createContext(c);
  vm.runInContext(code, c);
  return c;
}
for (const mode of ['New', 'Rework', 'IPM']) {
  for (const accept of [true, false]) {
    test(`${mode}: ${accept ? 'confirm saves' : 'cancel keeps form open'}`, async () => {
      const c = fixture(mode, mode === 'New' ? { exists: [10], missing: [] } : { exists: [], missing: [10] });
      c.accept = accept;
      await c.handleSave();
      assert.equal(!!c.saved, accept);
      if (mode === 'New') assert.equal(c.existingPrompt.join(','), '10');
      else assert.equal(c.registerPrompt[0].alpl, 10);
      if (accept) assert.equal(c.saved.groups[0].recieve_date, '2026-09-23');
    });
  }
}
test('New autofills registered data and clears those fields when ALPL changes to an unknown part', async () => {
  const c = fixture('New', { exists: [10], detail: { 10: {
    package_size: '5x5', part_number: 'OLD', vendor: 'OldV', owner: 'OldO', po_number: 8,
    description: 'Original', handler: 'Machine', receive_date: '2026-01-01' } } });
  await c.prefillGroup(0, '10');
  assert.equal(c.groupsRef.current[0].package_size, '5x5');
  assert.equal(c.groupsRef.current[0].handler, 'Machine');
  assert.equal(c.groupsRef.current[0].receive_date, '2026-01-01');
  c.groupsRef.current[0].number_alpl = '20';
  c.apiPost = async () => ({ exists: [], detail: {} });
  await c.prefillGroup(0, '20');
  assert.equal(c.groupsRef.current[0].package_size, '');
  assert.equal(c.groupsRef.current[0].handler, '');
});
test('lookup failure cannot silently skip confirmation', async () => {
  const c = fixture('New', {});
  c.apiPost = async () => { throw new Error('offline'); };
  await c.handleSave();
  assert.equal(c.saved, undefined);
});
