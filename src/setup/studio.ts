// ABIs for the Stablecoin Studio v4 diamond proxy and factory, plus the ContainmentController.
import fs from "node:fs";
import path from "node:path";
import type { Abi } from "viem";
import {
  BurnableFacet__factory,
  CashInFacet__factory,
  FreezableFacet__factory,
  PausableFacet__factory,
  RolesFacet__factory,
  StableCoinFactoryFacet__factory,
  SupplierAdminFacet__factory,
  WipeableFacet__factory,
} from "@hashgraph/stablecoin-npm-contracts";

function merge(...abis: readonly any[][]): Abi {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const abi of abis)
    for (const e of abi) {
      const sig = `${e.type}:${e.name}:${(e.inputs ?? []).map((i: any) => i.type).join(",")}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(e);
    }
  return out as Abi;
}

/** Everything callable on a Studio token proxy that setup and tests use. */
export const studioTokenAbi: Abi = merge(
  RolesFacet__factory.abi as any,
  SupplierAdminFacet__factory.abi as any,
  CashInFacet__factory.abi as any,
  FreezableFacet__factory.abi as any,
  WipeableFacet__factory.abi as any,
  PausableFacet__factory.abi as any,
  BurnableFacet__factory.abi as any,
);

export const studioFactoryAbi: Abi = StableCoinFactoryFacet__factory.abi as any;

export function controllerArtifact(): { abi: Abi; bytecode: `0x${string}` } {
  const file = path.resolve("build", "ContainmentController.json");
  if (!fs.existsSync(file)) throw new Error("build/ContainmentController.json missing: run npm run compile");
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const bc = String(j.bytecode);
  return { abi: j.abi, bytecode: (bc.startsWith("0x") ? bc : `0x${bc}`) as `0x${string}` };
}

/** ABIs to try when decoding a revert from a controller call (controller errors first, then Studio's). */
export function revertAbis(): Abi[] {
  return [controllerArtifact().abi, studioTokenAbi, studioFactoryAbi];
}
