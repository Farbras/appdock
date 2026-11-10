import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
// Generate the Ed25519 PEM outside this repository, e.g. with OpenSSL.
// Private key location is required explicitly, and no key material is logged.
const [input, output] = process.argv.slice(2);
const keyPath = process.env.APPDOCK_CATALOG_SIGNING_KEY;
if (!input || !output || !keyPath)
  throw new Error(
    "Usage: APPDOCK_CATALOG_SIGNING_KEY=<external PEM path> node scripts/sign-catalog.mjs payload.json catalog.signed.json",
  );
const payload = readFileSync(input);
const parsed = JSON.parse(payload);
if (
  parsed.schemaVersion !== 1 ||
  !Number.isSafeInteger(parsed.revision) ||
  parsed.revision < 1 ||
  !Array.isArray(parsed.apps)
)
  throw new Error("Invalid payload schema");
const key = createPrivateKey(readFileSync(keyPath));
if (key.asymmetricKeyType !== "ed25519")
  throw new Error("An Ed25519 key is required");
const signature = sign(null, payload, key);
writeFileSync(
  output,
  JSON.stringify(
    {
      payload: payload.toString("base64"),
      signature: signature.toString("base64"),
    },
    null,
    2,
  ),
);
const publicDer = createPublicKey(key).export({ type: "spki", format: "der" });
console.log(
  `Signed revision ${parsed.revision}. Public key (APPDOCK_CATALOG_PUBLIC_KEY): ${publicDer.subarray(-32).toString("base64")}`,
);
