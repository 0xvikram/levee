// In-process EVM harness for contract unit tests: compiles with solc-js (same settings as
// scripts/compile.ts) and executes with @ethereumjs/evm. No network, no keys, no testnet.
import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import { createEVM, type EVM } from "@ethereumjs/evm";
import { createAddressFromString, hexToBytes, bytesToHex } from "@ethereumjs/util";
import {
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  type Abi,
  type Hex,
} from "viem";

export type Compiled = { abi: Abi; bytecode: Hex };

const ROOT = path.resolve(import.meta.dirname, "../..");

/** Compile the controller and the mock in one solc run. */
export function compileAll(): Record<"ContainmentController" | "MockStudio", Compiled> {
  const files = {
    "ContainmentController.sol": path.join(ROOT, "contracts/ContainmentController.sol"),
    "MockStudio.sol": path.join(ROOT, "tests/contracts/MockStudio.sol"),
  };
  const sources = Object.fromEntries(
    Object.entries(files).map(([name, p]) => [name, { content: fs.readFileSync(p, "utf8") }]),
  );
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  const pick = (file: string, name: string): Compiled => {
    const c = out.contracts[file][name];
    return { abi: c.abi as Abi, bytecode: `0x${c.evm.bytecode.object}` as Hex };
  };
  return {
    ContainmentController: pick("ContainmentController.sol", "ContainmentController"),
    MockStudio: pick("MockStudio.sol", "MockStudio"),
  };
}

export type Log = { address: Hex; eventName: string; args: Record<string, unknown> };

export type CallResult =
  | { ok: true; result: unknown; logs: Log[] }
  | { ok: false; error: { errorName: string; args: readonly unknown[] | undefined }; raw: Hex };

export class Chain {
  private constructor(private evm: EVM) {}

  static async create(): Promise<Chain> {
    return new Chain(await createEVM());
  }

  async deploy(c: Compiled, from: Hex, args: readonly unknown[] = []): Promise<Contract> {
    const data = encodeDeployData({ abi: c.abi, bytecode: c.bytecode, args } as never);
    const res = await this.evm.runCall({
      caller: createAddressFromString(from),
      data: hexToBytes(data),
      gasLimit: 30_000_000n,
    });
    if (res.execResult.exceptionError || !res.createdAddress) {
      throw new Error(`deploy failed: ${res.execResult.exceptionError?.error}`);
    }
    return new Contract(this, c.abi, getAddress(res.createdAddress.toString()));
  }

  /** Abis used to decode logs from any address the test knows about. */
  readonly abis = new Map<string, Abi>();

  async raw(from: Hex, to: Hex, data: Hex) {
    return this.evm.runCall({
      caller: createAddressFromString(from),
      to: createAddressFromString(to),
      data: hexToBytes(data),
      gasLimit: 30_000_000n,
    });
  }
}

export class Contract {
  constructor(
    private chain: Chain,
    readonly abi: Abi,
    readonly address: Hex,
  ) {
    chain.abis.set(address.toLowerCase(), abi);
  }

  /** Send a call from `from`. Reverts are returned (decoded against this contract's ABI), not thrown. */
  async send(from: Hex, functionName: string, args: readonly unknown[] = []): Promise<CallResult> {
    const data = encodeFunctionData({ abi: this.abi, functionName, args } as never);
    const res = await this.chain.raw(from, this.address, data);
    const ret = bytesToHex(res.execResult.returnValue) as Hex;
    if (res.execResult.exceptionError) {
      if (ret === "0x") return { ok: false, error: { errorName: "<empty revert>", args: undefined }, raw: ret };
      const e = decodeErrorResult({ abi: this.abi, data: ret });
      return { ok: false, error: { errorName: e.errorName, args: e.args }, raw: ret };
    }
    const logs: Log[] = (res.execResult.logs ?? []).map(([addr, topics, logData]) => {
      const address = bytesToHex(addr) as Hex;
      const abi = this.chain.abis.get(address.toLowerCase()) ?? this.abi;
      const d = decodeEventLog({
        abi,
        topics: topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
        data: bytesToHex(logData) as Hex,
      });
      return { address, eventName: d.eventName as string, args: (d.args ?? {}) as Record<string, unknown> };
    });
    const result = decodeFunctionResult({ abi: this.abi, functionName, data: ret } as never);
    return { ok: true, result, logs };
  }

  /** Like send, but throws on revert and returns only the decoded result. */
  async read<T = unknown>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    const r = await this.send("0x000000000000000000000000000000000000dEaD", functionName, args);
    if (!r.ok) throw new Error(`${functionName} reverted: ${r.error.errorName}`);
    return r.result as T;
  }
}
