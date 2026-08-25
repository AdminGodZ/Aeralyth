import sodium from "libsodium-wrappers-sumo";

import { wipe } from "@/features/vault/protocol";

const CIPHERTEXT_LEAF_DOMAIN = 0;

export function incrementalCiphertextLeafHash(
  chunkIndex: number,
  ciphertext: Uint8Array,
): Uint8Array {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error("Invalid ciphertext chunk index.");
  }

  const prefix = new Uint8Array(9);
  prefix[0] = CIPHERTEXT_LEAF_DOMAIN;
  new DataView(prefix.buffer).setBigUint64(1, BigInt(chunkIndex), false);
  const state = sodium.crypto_hash_sha256_init();
  let finalized = false;
  try {
    sodium.crypto_hash_sha256_update(state, prefix);
    sodium.crypto_hash_sha256_update(state, ciphertext);
    const digest = sodium.crypto_hash_sha256_final(state);
    finalized = true;
    return digest;
  } finally {
    if (!finalized) {
      wipe(sodium.crypto_hash_sha256_final(state));
    }
    wipe(prefix);
  }
}
