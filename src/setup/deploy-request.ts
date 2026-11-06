// The deployStableCoin request, built the same way as the Studio SDK (TokenOperations.create). Pure.
import { KEY_TYPE, STUDIO_ROLES, STUDIO_TESTNET, TOKEN_SPEC } from "./plan.js";

const UINT256_MAX = (1n << 256n) - 1n;
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

export function buildDeployRequest(operatorEvm: string, resolverEvm: string) {
  const smartContractKey = (keyType: bigint) => ({ keyType, publicKey: "0x" as `0x${string}`, isEd25519: false });
  const roleFor = (role: string) => ({ role: role as `0x${string}`, account: operatorEvm as `0x${string}` });
  return {
    tokenName: TOKEN_SPEC.name,
    tokenSymbol: TOKEN_SPEC.symbol,
    freeze: false,
    supplyType: false, // infinite
    tokenMaxSupply: 0n,
    tokenInitialSupply: 0n,
    tokenDecimals: TOKEN_SPEC.decimals,
    reserveAddress: ZERO as `0x${string}`,
    updatedAtThreshold: 0n,
    reserveInitialAmount: 0n,
    createReserve: false,
    keys: [KEY_TYPE.admin, KEY_TYPE.freeze, KEY_TYPE.wipe, KEY_TYPE.supply, KEY_TYPE.pause].map(smartContractKey),
    roles: [
      STUDIO_ROLES.DEFAULT_ADMIN,
      STUDIO_ROLES.BURN,
      STUDIO_ROLES.WIPE,
      STUDIO_ROLES.RESCUE,
      STUDIO_ROLES.PAUSE,
      STUDIO_ROLES.FREEZE,
      STUDIO_ROLES.DELETE,
    ].map(roleFor),
    cashinRole: { account: operatorEvm as `0x${string}`, allowance: UINT256_MAX },
    metadata: "",
    businessLogicResolverAddress: resolverEvm as `0x${string}`,
    stableCoinConfigurationId: { key: STUDIO_TESTNET.stableCoinConfigId as `0x${string}`, version: STUDIO_TESTNET.stableCoinConfigVersion },
    reserveConfigurationId: { key: ZERO32 as `0x${string}`, version: 0n },
  };
}

