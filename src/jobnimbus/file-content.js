// JobNimbus sometimes stores PDFs as one ObjectOutputStream primitive byte[].
// This is a fixed framing decoder, NOT a Java object deserializer. Accept only
// the standard [B descriptor, no fields/annotations/superclass, an exact signed
// length, and a PDF header at the beginning of the payload. Never marker-scan,
// load classes, recurse, or accept trailing serialized objects.
const JAVA_STREAM_MAGIC = Buffer.from("aced0005", "hex");
const JAVA_BYTE_ARRAY_DESCRIPTOR = Buffer.from(
  "aced0005757200025b42acf317f8060854e00200007870", "hex"
);
const PDF_MAGIC = Buffer.from("%PDF-", "ascii");
const PAYLOAD_OFFSET = JAVA_BYTE_ARRAY_DESCRIPTOR.length + 4;

export class JobNimbusFileContentError extends Error {
  constructor() {
    super("JobNimbus returned unsupported document framing.");
    this.statusCode = 502;
    this.failureReason = "format_rejected";
  }
}

export function decodeJobNimbusPdfByteArray(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("Document bytes must be a Buffer");
  if (!bytes.subarray(0, JAVA_STREAM_MAGIC.length).equals(JAVA_STREAM_MAGIC)) return bytes;
  if (bytes.length < PAYLOAD_OFFSET + PDF_MAGIC.length
    || !bytes.subarray(0, JAVA_BYTE_ARRAY_DESCRIPTOR.length).equals(JAVA_BYTE_ARRAY_DESCRIPTOR)) {
    throw new JobNimbusFileContentError();
  }
  const declaredLength = bytes.readInt32BE(JAVA_BYTE_ARRAY_DESCRIPTOR.length);
  if (declaredLength !== bytes.length - PAYLOAD_OFFSET
    || !bytes.subarray(PAYLOAD_OFFSET, PAYLOAD_OFFSET + PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new JobNimbusFileContentError();
  }
  return bytes.subarray(PAYLOAD_OFFSET);
}
