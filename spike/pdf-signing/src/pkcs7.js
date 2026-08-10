'use strict';
/**
 * Detached PKCS#7 / CMS SignedData production.
 *
 * In production this is NOT where the signature comes from: the CCA-licensed ESP
 * produces the PKCS#7 blob after the Aadhaar OTP ceremony (see DEC-002, hash-based
 * model). This module exists so that (a) the spike can prove the incremental-update
 * mechanics end to end without a provider, and (b) the MockEsignProvider used
 * throughout development and CI behaves byte-compatibly with a real ESP response.
 */

const forge = require('node-forge');

/** Generate a self-signed signing certificate. Test/mock use only. */
function generateSigningCertificate({ commonName, organization = 'GTIDS', years = 2 }) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + years);

  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: organization },
    { name: 'countryName', value: 'IN' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', emailProtection: true, clientAuth: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return { certificate: cert, privateKey: keys.privateKey };
}

/**
 * Produce a detached CMS SignedData over `content` (a Buffer of the PDF ByteRange
 * bytes). Returns DER as a Buffer — this is exactly what goes into /Contents.
 */
function signDetached(content, { certificate, privateKey, signingTime = new Date() }) {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(content.toString('latin1'));
  p7.addCertificate(certificate);
  p7.addSigner({
    key: privateKey,
    certificate,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest }, // computed by forge over p7.content
      { type: forge.pki.oids.signingTime, value: signingTime },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'latin1');
}

/**
 * Independent-of-forge-internals check that a detached CMS blob actually commits
 * to `content`: pull the signed messageDigest attribute out of the DER and compare
 * it with SHA-256 of the content we believe was signed.
 */
function verifyMessageDigest(der, content) {
  const asn1 = forge.asn1.fromDer(der.toString('latin1'));
  const p7 = forge.pkcs7.messageFromAsn1(asn1);
  const signer = p7.rawCapture && p7.rawCapture.signerInfos && p7.rawCapture.signerInfos[0];
  if (!signer) return { ok: false, reason: 'no signerInfo' };

  const expected = forge.md.sha256.create();
  expected.update(content.toString('latin1'));
  const expectedHex = expected.digest().toHex();

  // Walk the authenticated attributes for the messageDigest OID (1.2.840.113549.1.9.4).
  const attrsSet = signer.value.find(
    (v) => v.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && v.type === 0,
  );
  if (!attrsSet) return { ok: false, reason: 'no authenticatedAttributes' };

  for (const attr of attrsSet.value) {
    const oid = forge.asn1.derToOid(attr.value[0].value);
    if (oid === forge.pki.oids.messageDigest) {
      const actualHex = forge.util.bytesToHex(attr.value[1].value[0].value);
      return { ok: actualHex === expectedHex, expectedHex, actualHex };
    }
  }
  return { ok: false, reason: 'messageDigest attribute absent' };
}

module.exports = { generateSigningCertificate, signDetached, verifyMessageDigest };
