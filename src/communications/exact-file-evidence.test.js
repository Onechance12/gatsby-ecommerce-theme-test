import assert from 'node:assert/strict';
import test from 'node:test';
import { exactFileEvidenceAnchors, exactFileRecipientProof, messageMatchesFile, isContactOptOut } from './exact-file-evidence.js';

const person = { display_name: 'Fixture Policyholder', email: 'owner@example.test', mobile_phone: '+12145550199' };
const first = { ...person, jnid: 'file-one', address_line1: '21 Maple Ave', cf_string_2: 'CLAIM-ONE-2026' };
const second = { ...person, jnid: 'file-two', address_line1: '90 Birch Ct', cf_string_2: 'CLAIM-TWO-2026' };

test('one person, several properties: contact details never attach case evidence', () => {
  const anchors = exactFileEvidenceAnchors(first, [first, second]);
  assert.equal(messageMatchesFile('Fixture Policyholder owner@example.test +12145550199 policy attached', anchors), false);
  assert.equal(messageMatchesFile('Policy for 21 Maple Avenue', anchors), true);
  assert.equal(messageMatchesFile('Policy for 90 Birch Court', anchors), false);
  assert.equal(messageMatchesFile('Both 21 Maple Ave and 90 Birch Court', anchors), false);
});

test('repeat claims at the same property require a unique claim, not the common address', () => {
  const repeat = { ...second, address_line1: first.address_line1 };
  const anchors = exactFileEvidenceAnchors(first, [first, repeat]);
  assert.equal(messageMatchesFile('Claim CLAIM-ONE-2026 for 21 Maple Avenue', anchors), true);
  assert.equal(messageMatchesFile('Policy for 21 Maple Ave', anchors), false);
  assert.equal(messageMatchesFile('Claims CLAIM-ONE-2026 and CLAIM-TWO-2026 at 21 Maple Ave', anchors), false);
});

test('a shared claim token is neither unique identity nor a veto of a unique property', () => {
  const duplicateToken = { ...second, cf_string_2: first.cf_string_2 };
  const anchors = exactFileEvidenceAnchors(first, [first, duplicateToken]);
  assert.equal(messageMatchesFile('CLAIM-ONE-2026 for 21 Maple Ave', anchors), true);
  assert.equal(messageMatchesFile('CLAIM-ONE-2026', anchors), false);
  assert.equal(exactFileEvidenceAnchors(first, [first, { ...duplicateToken, address_line1: first.address_line1 }]), null);
});

test('apartment/unit identifiers remain separate and cannot be lost to street normalization', () => {
  const unitTwo = { ...first, address_line2: 'Apt 2', cf_string_2: null };
  const unitThree = { ...second, address_line1: first.address_line1, address_line2: '#3', cf_string_2: null };
  const anchors = exactFileEvidenceAnchors(unitTwo, [unitTwo, unitThree]);
  assert.equal(messageMatchesFile('21 Maple Avenue unit 2', anchors), true);
  assert.equal(messageMatchesFile('21 Maple Ave', anchors), false);
  assert.equal(messageMatchesFile('21 Maple Ave unit 3', anchors), false);
  assert.equal(messageMatchesFile('21 Maple Ave unit 2 and 21 Maple Avenue unit 3', anchors), false);
});

test('recipients are file members, never a phone-based file lookup or customer merge', () => {
  const file = { id: first.jnid, name: person.display_name, phone: person.mobile_phone, address: first.address_line1, claimNumber: first.cf_string_2, adjusterPhone: '+19725550130' };
  const proof = exactFileRecipientProof(file, '(214) 555-0199');
  assert.equal(proof.role, 'client');
  assert.equal(exactFileRecipientProof(file, '+19725550130').role, 'desk_adjuster');
  assert.equal(exactFileRecipientProof(file, '+12145550198'), null);
  assert.equal(exactFileRecipientProof({ ...file, phone: '+12145550198' }, person.mobile_phone), null);
  assert.equal(exactFileRecipientProof({ ...file, phone: { unsafe: person.mobile_phone } }, person.mobile_phone), null);
  assert.notDeepEqual(proof, exactFileRecipientProof({ ...file, address: second.address_line1 }, person.mobile_phone));
  assert.notDeepEqual(proof, exactFileRecipientProof({ ...file, claimNumber: second.cf_string_2 }, person.mobile_phone));
  assert.notDeepEqual(proof, exactFileRecipientProof({ ...file, name: 'Another policyholder' }, person.mobile_phone));
  assert.notDeepEqual(proof, exactFileRecipientProof({ ...file, id: second.jnid }, person.mobile_phone));
  assert.equal(exactFileRecipientProof({ ...file, id: '' }, person.mobile_phone), null);
});

test('non-finite or unsafe numeric identifiers never provide a file anchor', () => {
  for (const claim of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const malformed = { ...first, cf_string_2: claim };
    assert.equal(exactFileEvidenceAnchors(malformed, [malformed, second]), null);
  }
});

test('opt-out is contact-level and is not attached to only the named property', () => {
  for (const text of ['STOP', 'Please don’t text me about 90 Birch Ct', "Don't contact us"]) {
    assert.equal(isContactOptOut({ type: 'text', direction: 'incoming', text }), true);
  }
  assert.equal(isContactOptOut({ type: 'text', direction: 'outgoing', text: 'STOP' }), false);
  assert.equal(isContactOptOut({ type: 'call', direction: 'incoming', text: 'STOP' }), false);
});
