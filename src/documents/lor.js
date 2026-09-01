import PDFDocument from "pdfkit";

const BLUE = "#004f91";
const WAVE_LEGAL_PAYEE_NAME = "Wave Public Adjusting LLC";

function deterministicPdfDate(value) {
  const match = String(value || "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) {
    throw new Error("letterDate must use MM/DD/YYYY to generate a deterministic LOR.");
  }
  const [, month, day, year] = match;
  const timestamp = new Date(`${year}-${month}-${day}T12:00:00.000Z`);
  if (
    Number.isNaN(timestamp.getTime())
    || timestamp.getUTCFullYear() !== Number(year)
    || timestamp.getUTCMonth() + 1 !== Number(month)
    || timestamp.getUTCDate() !== Number(day)
  ) {
    throw new Error("letterDate is not a valid calendar date.");
  }
  return timestamp;
}

export async function createLorPdf(fields) {
  const required = ["insured", "carrier", "addressLine1", "addressLine2", "dateOfLoss", "claimNumber"];
  for (const key of required) {
    const value = String(fields[key] || "").trim();
    if (!value || /\b(?:unknown|missing|tbd)\b/i.test(value)) {
      throw new Error(`${key} is required to generate the LOR.`);
    }
  }

  const metadataDate = deterministicPdfDate(fields.letterDate);
  const doc = new PDFDocument({
    size: "LETTER",
    margin: 56,
    autoFirstPage: true,
    info: {
      Title: `LOR - ${fields.insured}`,
      CreationDate: metadataDate,
      ModDate: metadataDate
    }
  });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = 56;
  const right = 556;
  const width = right - left;

  doc.fillColor(BLUE).font("Times-Roman").fontSize(27).text(WAVE_LEGAL_PAYEE_NAME, left, 42, { lineBreak: false });
  doc.fillColor("#777777").font("Helvetica").fontSize(15).text("TX License #: 3351885", left, 76, { lineBreak: false });
  doc.fillColor(BLUE).font("Times-Roman").fontSize(13);
  ["3500 Oak Lawn Ave", "Suite 460C", "Dallas, TX 75219"].forEach((line, index) => {
    doc.text(line, 390, 48 + index * 17, { width: 166, align: "right", lineBreak: false });
  });

  let y = 136;
  const field = (label, value, gap = 22) => {
    doc.fillColor("#000000").font("Helvetica").fontSize(11.5).text(label, left, y, { width: 105, lineBreak: false });
    doc.text(String(value), left + 112, y, { width: 360, lineBreak: false });
    y += gap;
  };
  field("DATE:", fields.letterDate);
  field("CARRIER:", fields.carrier);
  y += 4;
  field("INSURED:", fields.insured, 19);
  field("ADDRESS:", fields.addressLine1, 19);
  field("", fields.addressLine2, 28);
  field("DOL:", fields.dateOfLoss, 19);
  field("CLAIM #:", fields.claimNumber, 28);

  doc.font("Helvetica").fontSize(11.5).text("Attention Claims Department:", left, y, { width });
  y += 27;
  doc.text(
    `Please be advised that we, ${WAVE_LEGAL_PAYEE_NAME}, represent the named insured for their loss as stated above. We have previously forwarded to you a copy of our Texas Public Adjusters Agreement with the insured (FIN535). As stated by the insured, we hereby request that all further communication and correspondence regarding this claim be directed to this office.`,
    left,
    y,
    { width, lineGap: 3 }
  );
  y = doc.y + 12;
  doc.text(
    `The name "${WAVE_LEGAL_PAYEE_NAME}" must be included on all drafts, checks, and correspondence pertaining to this loss, and mailed directly to:`,
    left,
    y,
    { width, lineGap: 3 }
  );
  y = doc.y + 8;
  doc.text(`${WAVE_LEGAL_PAYEE_NAME}\n3500 Oak Lawn Ave #460C\nDallas TX 75219`, left, y, { width, align: "center", lineGap: 2 });
  y = doc.y + 12;
  doc.text("Kindly contact me as soon as possible to discuss this loss or set an appointment to inspect this claim.", left, y, { width, lineGap: 3 });
  y = doc.y + 14;
  doc.text("Sincerely,", left, y, { width });
  y = doc.y + 18;
  doc.font("Times-Roman").fontSize(25).text("Chance Pearson", left, y, { width, lineBreak: false });
  y += 34;
  doc.font("Helvetica").fontSize(11.5).text(
    `cpearson@wavepa.com\n972.573.1730\n${WAVE_LEGAL_PAYEE_NAME}\n3500 Oak Lawn Ave #460C\nDallas, TX 75219`,
    left,
    y,
    { width, lineGap: 1 }
  );

  doc.end();
  return complete;
}
