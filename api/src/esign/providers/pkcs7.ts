import * as forge from 'node-forge';

/**
 * Detached PKCS#7 / CMS SignedData production.
 *
 * This is NOT how production signatures are produced. In production the
 * CCA-licensed ESP creates the PKCS#7 after the Aadhaar OTP ceremony and GTIDS
 * only embeds it (DEC-002, hash-based model). This module exists so the mock
 * provider used in development, CI and the E2E workflow tests returns something
 * byte-compatible with a real ESP response, exercising the same embedding and
 * verification code paths.
 */

export interface SigningIdentity {
  certificate: forge.pki.Certificate;
  privateKey: forge.pki.PrivateKey;
}

const identities = new Map<string, SigningIdentity>();

/**
 * A stable self-signed identity per common name, generated once per process.
 * RSA-2048 keygen costs ~1s, and tests sign repeatedly as the same parties.
 */
export function signingIdentityFor(commonName: string): SigningIdentity {
  const cached = identities.get(commonName);
  if (cached) return cached;

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);

  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'GTIDS Mock eSign Provider' },
    { name: 'countryName', value: 'IN' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', emailProtection: true, clientAuth: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const identity: SigningIdentity = { certificate: cert, privateKey: keys.privateKey };
  identities.set(commonName, identity);
  return identity;
}

/** Detached CMS over `content`; the DER goes straight into /Contents. */
export function signDetached(
  content: Buffer,
  identity: SigningIdentity,
  signingTime: Date = new Date(),
): Buffer {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(content.toString('latin1'));
  p7.addCertificate(identity.certificate);
  p7.addSigner({
    key: identity.privateKey as forge.pki.rsa.PrivateKey,
    certificate: identity.certificate,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: signingTime as unknown as string },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'latin1');
}

export function certificateSubject(identity: SigningIdentity): {
  subject: string;
  serial: string;
} {
  const cn = identity.certificate.subject.getField('CN')?.value ?? 'unknown';
  return { subject: `CN=${cn}, O=GTIDS Mock eSign Provider, C=IN`, serial: identity.certificate.serialNumber };
}
