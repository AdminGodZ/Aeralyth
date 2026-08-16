const MODERN_VAULT_NODE_ID = /^fil_[A-Za-z0-9_-]{4,92}$/u;
const LEGACY_UUID_VAULT_NODE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isVaultNodeId(value: string): boolean {
  return (
    MODERN_VAULT_NODE_ID.test(value) || LEGACY_UUID_VAULT_NODE_ID.test(value)
  );
}
