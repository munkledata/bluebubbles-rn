import { createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const installed = createRequire(join(process.cwd(), 'package.json'));
const forge = installed('node-forge');
const pem = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicExponent: 65537,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const keys = {
  privateKey: forge.pki.privateKeyFromPem(pem.privateKey),
  publicKey: forge.pki.publicKeyFromPem(pem.publicKey),
};
const { asn1 } = forge;
const malformed = /ASN\.1 object does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo value/;

function digestInfoSignature(algorithm: string, kind: string, digest: string): string {
  const children = [
    asn1.create(
      asn1.Class.UNIVERSAL,
      asn1.Type.OID,
      false,
      asn1.oidToDer(forge.oids[algorithm]).getBytes(),
    ),
  ];
  if (kind !== 'absent' && kind !== 'extra-without-null') {
    children.push(
      asn1.create(
        asn1.Class.UNIVERSAL,
        asn1.Type.NULL,
        false,
        kind === 'nonempty-null' ? 'synthetic malformed parameter' : '',
      ),
    );
  }
  if (kind.startsWith('extra')) {
    children.push(
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, 'synthetic extra child'),
    );
  }
  const der = asn1
    .toDer(
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, children),
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest),
      ]),
    )
    .getBytes();
  // NONE supplies custom DigestInfo bytes at signing time. Normal PKCS#1 padding is
  // still emitted; verify below uses the default scheme and all padding checks.
  return keys.privateKey.sign(der, 'NONE') as string;
}

describe.each(['sha1', 'sha224', 'sha256', 'sha384', 'sha512'])(
  'RSA DigestInfo %s',
  (algorithm) => {
    const digest = createHash(algorithm)
      .update('Gator synthetic signature regression')
      .digest('latin1');

    it.each(['null', 'absent'])('accepts the valid %s parameter encoding', (kind) => {
      expect(keys.publicKey.verify(digest, digestInfoSignature(algorithm, kind, digest))).toBe(
        true,
      );
    });

    it.each(['extra-after-null', 'extra-without-null', 'nonempty-null'])(
      'rejects %s while retaining normal padding validation',
      (kind) => {
        // These use our synthetic private key to test parser rejection; they do not
        // demonstrate a signature forgery without a private key.
        expect(() =>
          keys.publicKey.verify(digest, digestInfoSignature(algorithm, kind, digest)),
        ).toThrow(malformed);
      },
    );
  },
);

it('retains the existing MD5 parameter requirement and digest comparison', () => {
  const md5 = createHash('md5').update('synthetic compatibility').digest('latin1');
  expect(keys.publicKey.verify(md5, digestInfoSignature('md5', 'null', md5))).toBe(true);
  expect(() => keys.publicKey.verify(md5, digestInfoSignature('md5', 'absent', md5))).toThrow();
  const digest = createHash('sha256').update('synthetic compatibility').digest('latin1');
  expect(keys.publicKey.verify('x'.repeat(32), digestInfoSignature('sha256', 'null', digest))).toBe(
    false,
  );
});

it('retains actual Expo certificate generation, validation, and buffer signing', () => {
  const expo = installed('@expo/code-signing-certificates');
  const now = Date.now();
  const certificate = expo.generateSelfSignedCodeSigningCertificate({
    keyPair: keys,
    validityNotBefore: new Date(now - 60_000),
    validityNotAfter: new Date(now + 60_000),
    commonName: 'Gator synthetic signature regression',
  });
  expo.validateSelfSignedCertificate(certificate, keys);
  const signature = expo.signBufferRSASHA256AndVerify(
    keys.privateKey,
    certificate,
    Buffer.from('synthetic input'),
  );
  expect(signature).toEqual(expect.any(String));
  expect(signature.length).toBeGreaterThan(0);
});
