import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const contractsDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(contractsDirectory, "KvaraProfileRegistry.sol");
const artifactPath = path.join(contractsDirectory, "out", "KvaraProfileRegistry.json");

export function compileProfileRegistry() {
  const source = fs.readFileSync(sourcePath, "utf8");
  const input = {
    language: "Solidity",
    sources: {
      "KvaraProfileRegistry.sol": { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"],
        },
      },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((entry) => entry.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
  }
  const compiled = output.contracts?.["KvaraProfileRegistry.sol"]?.KvaraProfileRegistry;
  if (!compiled?.evm?.bytecode?.object) throw new Error("Profile registry bytecode is missing.");
  return {
    contractName: "KvaraProfileRegistry",
    sourceName: "KvaraProfileRegistry.sol",
    compilerVersion: solc.version(),
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`,
    deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
    metadata: compiled.metadata,
  };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const artifact = compileProfileRegistry();
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Compiled ${artifact.contractName} with ${artifact.compilerVersion}`);
  console.log(`Artifact: ${artifactPath}`);
}
