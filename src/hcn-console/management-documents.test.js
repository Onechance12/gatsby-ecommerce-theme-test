import assert from "node:assert/strict";
import test from "node:test";
import { managementDocumentActivities } from "./management-documents.js";
const options = {fileId:"file-a",knownFileIds:new Set(["file-a","file-b"]),asOf:"2026-09-18T15:00:00.000Z"};
const doc = {jnid:"doc-a",related:[{id:"file-a"}],date_created:1789668000,created_by:"human-user",created_by_name:"Fixture Adjuster",name:"private.pdf"};
test("upload counts without an activity row and uses creation not modification or filename",()=>{
 const r=managementDocumentActivities([{...doc,date_updated:Date.parse(options.asOf)/1000,name:"2099-01-01.pdf"}],options);
 assert.equal(r.events.length,1); assert.equal(r.events[0].occurredAt,new Date(doc.date_created*1000).toISOString());
 assert.equal(r.events[0].evidenceId,"document:doc-a"); assert.equal(r.summary.counted,1);
 assert.doesNotMatch(JSON.stringify(r),/private|Fixture|human-user|2099/);
});
test("automation, drafts and deleted files do not refresh work; missing provenance stays uncertain",()=>{
 for(const fields of [{is_automated:true},{created_by_name:"Zapier"},{status_name:"Draft"},{is_deleted:true},{source_type:"import"}]) {
  const r=managementDocumentActivities([{...doc,...fields}],options);assert.equal(r.events.length,0);assert.equal(r.summary.excluded,1);
 }
 for(const fields of [{date_created:null},{date_created:"2099-01-01"},{created_by:null,created_by_name:null}]) {
  const r=managementDocumentActivities([{...doc,...fields}],options);assert.equal(r.events.length,0);assert.equal(r.summary.uncertain,1);
 }
});
test("cross-file, unrelated and duplicate documents cannot produce a false touch",()=>{
 const r=managementDocumentActivities([{...doc,related:[{id:"file-a"},{id:"file-b"}]}],options);
 assert.equal(r.summary.ambiguous,1);assert.equal(r.events.length,0);
 assert.throws(()=>managementDocumentActivities([{...doc,related:[{id:"file-b"}]}],options),/scope/);
 assert.throws(()=>managementDocumentActivities([doc,doc],options),/duplicate/);
});
