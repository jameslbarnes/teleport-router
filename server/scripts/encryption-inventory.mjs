// Read-only inventory. Private author metadata is encrypted before leaving the
// runner. The corresponding private key exists only on Ellis's local workspace.
import {initializeApp,cert,deleteApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes,createCipheriv,publicEncrypt,constants} from 'node:crypto';
import {join} from 'node:path';
const app=initializeApp({credential:cert(JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,'base64').toString('utf8')))});
try {
  const db=getFirestore(app);
  const users=await db.collection('users').select('tinycloud.ownerDid','tinycloud.space','tinycloud.prefix','tinycloud.minRecordVersion').get();
  const linked=users.docs.filter(d=>d.data().tinycloud?.ownerDid).map(d=>({handle:d.id,...d.data().tinycloud}));
  const plaintext=Buffer.from(JSON.stringify({capturedAt:new Date().toISOString(),linked},null,2));
  const key=randomBytes(32),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from('router-author-inventory-v1'));
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);plaintext.fill(0);
  const publicKey=await readFile('../inventory-public.pem','utf8');
  const wrapped=publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key);key.fill(0);
  await writeFile(join(process.env.RUNNER_TEMP,'author-inventory.enc.json'),JSON.stringify({version:1,wrapped:wrapped.toString('base64'),nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));
  console.log('Read-only inventory encrypted for its local recipient. No database writes performed.');
} catch {
  console.error('Private inventory failed; no author metadata or credentials logged.');process.exitCode=1;
} finally {await deleteApp(app);}
