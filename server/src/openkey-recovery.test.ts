import { createHash, randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { SiweMessage } from 'siwe';
import { verifyMessage } from 'ethers';
import { testWallet } from './author-test-fixtures.js';
import { linkMessage, networkRecovery, recoveryPath } from './openkey-recovery.js';

const site = 'https://router.example', signer = testWallet('openkey'), old = testWallet('previous-owner');
const did = 'did:pkh:eip155:1:' + signer.address;
const encrypted = randomBytes(80).toString('base64');
const network = { publicKey:testWallet('independent-recovery').signingKey.compressedPublicKey, envelope:{
  v:2,networkId:'urn:tinycloud:encryption:'+did+':default',keyPath:'apps/example.router/recovery',alg:'x25519-aes256gcm/v1',keyVersion:1,
  encryptedSymmetricKey:encrypted,encryptedSymmetricKeyHash:createHash('sha256').update(JSON.stringify(encrypted)).digest('hex'),ciphertext:randomBytes(60).toString('base64')}};

describe('OpenKey storage ownership',()=>{
  it('accepts only the named recovery key for the owner and the current site',()=>{
    expect(recoveryPath(site)).toBe(network.envelope.keyPath);
    expect(networkRecovery(network,did,site)).toEqual(network);
    for(const overrides of [{keyPath:'apps/example.other/recovery'},{networkId:'urn:tinycloud:encryption:'+did+':different'},{encryptedSymmetricKeyHash:'0'.repeat(64)}])
      expect(()=>networkRecovery({...network,envelope:{...network.envelope,...overrides}},did,site)).toThrow();
  });
  it('both owners sign parseable, expiring SIWE messages with the same move, grant and recovery resources',async()=>{
    const config = networkRecovery(network,did,site), grant = 'e'.repeat(64);
    const move = {from:'did:pkh:eip155:1:'+old.address,to:did}, now=Date.now();
    const messages = [old,signer].map(w=>linkMessage(site,w.address,'author',grant,config,'f'.repeat(32),now,now+600000,move));
    const parsed = messages.map(m=>new SiweMessage(m));
    expect(parsed[0].resources).toEqual(parsed[1].resources);
    expect(parsed[0].resources).toContain('urn:router:migrate-to:'+did);
    expect(parsed[1].domain).toBe('router.example');
    expect(parsed[1].uri).toBe(site);
    expect(parsed[1].expirationTime).toBe(new Date(now+600000).toISOString());
    expect(verifyMessage(messages[0],await old.signMessage(messages[0]))).toBe(old.address);
    expect(verifyMessage(messages[1],await signer.signMessage(messages[1]))).toBe(signer.address);
  });
});
