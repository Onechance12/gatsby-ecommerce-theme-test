import assert from 'node:assert/strict';
import test from 'node:test';
import { messageMatchesFile, projectSharedPhoneFileHistory, sharedPhoneFileAnchors } from './exact-file-history.js';

const target = { jnid: 'target-fixture', address_line1: '21 Maple Ave', cf_string_2: 'SYNTH-614027ZX' };
const foreign = { jnid: 'other-property-fixture', address_line1: '90 Birch Ct', cf_string_2: 'SYNTH-95281740' };
const anchors = () => sharedPhoneFileAnchors(target, [target, foreign]);
const message = (text, extra = {}) => ({ id: 'message-fixture', type: 'text', direction: 'incoming', text, ...extra });

test('unique current property or claim, never a shared homeowner name, anchors a message', () => {
  assert.equal(messageMatchesFile('Please send the policy for 21 Maple Ave.', anchors()), true);
  assert.equal(messageMatchesFile('Claim SYNTH-614027ZX has an update.', anchors()), true);
  assert.equal(messageMatchesFile('For 21 Maple Avenue', anchors()), true);
  for (const text of ['Hi Fixture Homeowner', 'The policy is attached', 'Claim SYNTH-614027ZXX', 'For 121 Maple Ave']) {
    assert.equal(messageMatchesFile(text, anchors()), false, text);
  }
});

test('mixed-property messages, other properties and unbound calls are withheld', () => {
  const result = projectSharedPhoneFileHistory([
    message('The policy for 21 Maple Ave is requested.', { id: 'exact' }),
    message('SECRET_OTHER_PROPERTY: policy for 90 Birch Ct', { id: 'foreign' }),
    message('SECRET_MIXED: 21 Maple Ave and 90 Birch Ct', { id: 'mixed-address' }),
    message('SECRET_MIXED: 21 Maple Ave claim SYNTH-95281740', { id: 'mixed-claim' }),
    message('SECRET_UNBOUND: the policy is attached', { id: 'generic' }),
    { id: 'unbound-call', type: 'call', text: 'SECRET_CALL' }
  ], anchors());
  assert.deepEqual(result.items.map(item => item.id), ['exact']);
  assert.equal(result.withheld, 5);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_/);
});

test('destination opt-outs are retained as minimized safety facts, not other property content', () => {
  for (const text of ['STOP', 'unsubscribe', 'Please do not text me about SECRET_OTHER_PROPERTY anymore.']) {
    const result = projectSharedPhoneFileHistory([message(text)], anchors());
    assert.equal(result.items.length, 1);
    assert.match(result.items[0].text, /opt-out.*Do not send/);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_OTHER_PROPERTY/);
  }
  assert.equal(projectSharedPhoneFileHistory([message('STOP', { direction: 'outgoing' })], anchors()).items.length, 0);
});

test('no unique anchor, changed detail/index or malformed inventories never authorize attribution', () => {
  assert.equal(sharedPhoneFileAnchors(target, [target, { ...foreign, address_line1: target.address_line1, cf_string_2: target.cf_string_2 }]), null);
  assert.equal(sharedPhoneFileAnchors({ ...target, address_line1: '22 Maple Ave' }, [target, foreign]), null);
  assert.equal(sharedPhoneFileAnchors(target, [foreign]), null);
  assert.equal(sharedPhoneFileAnchors(target, [target, { ...foreign, cf_string_2: { unsafe: 'SYNTH-614027ZX' } }]), null);
  assert.equal(sharedPhoneFileAnchors(target, [target, { ...target, address_line1: '22 Maple Ave' }]), null);
  assert.equal(sharedPhoneFileAnchors(target, [target, null]), null);
  assert.equal(sharedPhoneFileAnchors(target, [target, { address_line1: '90 Birch Ct' }]), null);
  assert.equal(projectSharedPhoneFileHistory([], null), null);
});

test('identical duplicate index rows do not invent a new file; shared anchors cannot be used', () => {
  assert.ok(sharedPhoneFileAnchors(target, [target, { ...target }, foreign]));
  const sharedAddress = { ...foreign, address_line1: target.address_line1 };
  const scoped = sharedPhoneFileAnchors(target, [target, sharedAddress]);
  assert.equal(messageMatchesFile('21 Maple Ave', scoped), false);
  assert.equal(messageMatchesFile('SYNTH-614027ZX', scoped), true);
});
