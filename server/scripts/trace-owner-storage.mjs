// What the owner's own storage said about one trace record, for trace-app-owner.mjs.
//
// Only two answers are trusted: a record that is there, and the storage SDK's answer for a key that does not
// exist, which is the error code KV_NOT_FOUND with the message "Key not found: <the key asked for>"
// (@tinycloud/sdk-services, KV classifyNotFound). The same code with any other message, for example a space the
// node does not host, a success with no record in it, or any other error, means it is not known whether a trace
// is stored, and the owner tool stops without uploading or running anything.

/** 'stored', 'none' (confirmed missing) or 'unknown'. */
export function traceRecordState(got, key) {
  if (got && got.ok === true) {
    const data = got.data?.data;
    return data !== undefined && data !== null && data !== '' ? 'stored' : 'unknown';
  }
  if (got && got.ok === false && got.error?.code === 'KV_NOT_FOUND' && got.error?.message === `Key not found: ${key}`) return 'none';
  return 'unknown';
}
