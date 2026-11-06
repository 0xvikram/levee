// Read-only: list Levee's machine passes on Arkiv (Rabdi testnet). No keys needed.
// Usage: npx tsx scripts/arkiv-query.ts [ownerWallet]
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { eq } from "@arkiv-network/sdk/query";
import { http, type Hex } from "viem";
import { PassSchema } from "../src/shared/arkiv.js";

const CHECKER = (process.argv[2] ?? "0x929adc87e7acf502cff59a7dbb021517be1b876d") as Hex;
// Optional ARKIV_ACCESS_KEY avoids the public endpoint's rate limit; not required.
const pub = createPublicClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY }), transport: http() });

const { entities: all } = await pub.select().from(PassSchema).ownedBy(CHECKER).limit(100).fetch();
console.log(`passes owned by ${CHECKER}: ${all.length}`);
for (const e of all as any[]) console.log(JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

const { entities: one } = await pub.select().from(PassSchema).where(eq("machine", "payouts-server")).ownedBy(CHECKER).limit(1).fetch();
console.log(`payouts-server live pass: ${one.length ? "yes" : "no (expired or never created)"}`);
