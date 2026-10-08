import assert from "node:assert/strict";
import test from "node:test";
import { createGmailAttachmentReferences } from "./attachment-reference.js";

const binding = { subject: "synthetic-mac", fileId: "synthetic-file", messageId: "synthetic-message" };
const attachment = {
  partId: "1", partPath: "0.1", filename: "coverage.pdf", mimeType: "application/pdf", size: 500,
  attachmentId: "old-download-token"
};

test("Gmail attachment references select a fresh download token without changing the verified MIME part", () => {
  const refs = createGmailAttachmentReferences();
  const reference = refs.create(binding, attachment);
  const fresh = { ...attachment, attachmentId: "rotated-download-token" };
  assert.equal(refs.resolve(reference, binding, [fresh]), fresh);
});

test("Gmail attachment references reject wrong file, message, principal, or forged selectors", () => {
  const refs = createGmailAttachmentReferences();
  const reference = refs.create(binding, attachment);
  for (const key of ["subject", "fileId", "messageId"]) {
    assert.throws(() => refs.resolve(reference, { ...binding, [key]: "other" }, [attachment]), /invalid, expired/);
  }
  assert.throws(() => refs.resolve(`${reference}x`, binding, [attachment]), /invalid, expired/);
  assert.throws(() => refs.resolve("guess.coverage.pdf", binding, [attachment]), /invalid, expired/);
  assert.throws(() => refs.resolve(reference, binding, []), /invalid, expired/);
});

test("Gmail attachment references reject changed MIME location or material metadata", () => {
  const refs = createGmailAttachmentReferences();
  const reference = refs.create(binding, attachment);
  for (const [key, value] of Object.entries({
    partId: "2", partPath: "0.2", filename: "other.pdf", mimeType: "image/png", size: 501
  })) {
    assert.throws(() => refs.resolve(reference, binding, [{ ...attachment, [key]: value }]), /no longer matches/);
  }
});

test("Gmail attachment references distinguish duplicate filenames but reject duplicate MIME identities", () => {
  const refs = createGmailAttachmentReferences();
  const reference = refs.create(binding, attachment);
  const another = { ...attachment, partId: "2", partPath: "0.2", attachmentId: "other-token" };
  assert.equal(refs.resolve(reference, binding, [another, attachment]), attachment);
  assert.throws(() => refs.resolve(reference, binding, [attachment, { ...attachment }]), /invalid, expired/);
});

test("Gmail attachment references expire and do not survive a bridge restart", () => {
  let time = 1000;
  const refs = createGmailAttachmentReferences({ now: () => time, lifetimeMs: 100 });
  const reference = refs.create(binding, attachment);
  time = 1100;
  assert.throws(() => refs.resolve(reference, binding, [attachment]), /expired/);
  assert.throws(() => createGmailAttachmentReferences().resolve(reference, binding, [attachment]), /invalid/);
  assert.equal(refs.create(binding, { ...attachment, size: "500" }), null);
  assert.equal(refs.create({ ...binding, fileId: "" }, attachment), null);
});
