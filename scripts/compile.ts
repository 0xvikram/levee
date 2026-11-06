// Compiles contracts/ContainmentController.sol with solc-js and writes build/ContainmentController.json
import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const file = "ContainmentController.sol";
const source = fs.readFileSync(path.join("contracts", file), "utf8");

const input = {
  language: "Solidity",
  sources: { [file]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
for (const e of out.errors ?? []) console.log(e.formattedMessage);
if (errors.length) process.exit(1);

const c = out.contracts[file].ContainmentController;
fs.mkdirSync("build", { recursive: true });
fs.writeFileSync(
  path.join("build", "ContainmentController.json"),
  JSON.stringify({ abi: c.abi, bytecode: c.evm.bytecode.object }, null, 2),
);
console.log(`compiled: bytecode ${c.evm.bytecode.object.length / 2} bytes, ${c.abi.length} ABI entries`);
