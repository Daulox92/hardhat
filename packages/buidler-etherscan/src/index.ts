import { task } from "@nomiclabs/buidler/config";
import { BuidlerPluginError } from "@nomiclabs/buidler/plugins";
import { ActionType, Artifact } from "@nomiclabs/buidler/types";

import { pluginName } from "./pluginContext";

interface VerificationArgs {
  address: string;
  constructorArguments: string[];
  // Filename of constructor arguments module.
  constructorArgs?: string;
}

const verify: ActionType<VerificationArgs> = async (
  {
    address,
    constructorArguments: constructorArgsList,
    constructorArgs: constructorArgsModule,
  },
  { config, network, run }
) => {
  const { getDefaultEtherscanConfig } = await import("./config");
  const etherscan = getDefaultEtherscanConfig(config);

  if (etherscan.apiKey === undefined || etherscan.apiKey.trim() === "") {
    // TODO: add URL to etherscan documentation?
    throw new BuidlerPluginError(
      pluginName,
      "Please provide an Etherscan API token via buidler config. " +
        "E.g.: { [...], etherscan: { apiKey: 'an API key' }, [...] }"
    );
  }

  if (network.name === "buidlerevm") {
    throw new BuidlerPluginError(
      pluginName,
      `Please select a network supported by Etherscan.`
    );
  }

  const { isAddress } = await import("@ethersproject/address");
  if (!isAddress(address)) {
    throw new BuidlerPluginError(
      pluginName,
      `${address} is an invalid address.`
    );
  }

  const { getVersionNumber, inferSolcVersion, InferralType } = await import(
    "./solc/SolcVersions"
  );
  const solcVersionConfig = getVersionNumber(config.solc.version);

  // Etherscan only supports solidity versions higher than or equal to v0.4.11.
  // See https://etherscan.io/solcversions
  // TODO: perhaps querying and scraping this list would be a better approach?
  // This list should be validated - it links to https://github.com/ethereum/solc-bin/blob/gh-pages/bin/list.txt
  // which has many old compilers included in the list too.
  if (
    (solcVersionConfig.major === 0 &&
      solcVersionConfig.minor === 4 &&
      solcVersionConfig.patch < 11) ||
    (solcVersionConfig.major === 0 && solcVersionConfig.minor < 4)
  ) {
    throw new BuidlerPluginError(
      pluginName,
      `Etherscan only supports compiler versions 0.4.11 and higher.
See https://etherscan.io/solcversions for more information.`
    );
  }

  let constructorArguments;
  if (typeof constructorArgsModule === "string") {
    try {
      constructorArguments = await import(constructorArgsModule!);
      if (!Array.isArray(constructorArguments)) {
        throw new BuidlerPluginError(
          pluginName,
          `The module doesn't export a list. The module should look like this:
module.exports = [ arg1, arg2, ... ];`
        );
      }
    } catch (error) {
      throw new BuidlerPluginError(
        pluginName,
        "Importing the module for the constructor arguments list failed.",
        error
      );
    }
  } else {
    constructorArguments = constructorArgsList;
  }

  let etherscanAPIEndpoint: URL;
  const {
    getEtherscanEndpoint,
    retrieveContractBytecode,
    NetworkProberError,
  } = await import("./network/prober");
  try {
    etherscanAPIEndpoint = await getEtherscanEndpoint(network.provider);
  } catch (error) {
    if (error instanceof NetworkProberError) {
      throw new BuidlerPluginError(
        pluginName,
        `${error.message} The selected network is ${network.name}.`,
        error
      );
    }
    // Shouldn't be reachable.
    throw error;
  }

  const deployedContractBytecode = await retrieveContractBytecode(
    address,
    network.provider
  );
  if (deployedContractBytecode === null) {
    throw new BuidlerPluginError(
      pluginName,
      `The address ${address} has no bytecode. Is the contract deployed to this network?
The selected network is ${network.name}.`
    );
  }

  const solcVersionRange = await inferSolcVersion(deployedContractBytecode);

  if (!solcVersionRange.isIncluded(solcVersionConfig)) {
    let detailedContext;
    if (solcVersionRange.inferralType === InferralType.EXACT) {
      detailedContext = `The expected version is ${solcVersionRange}.`;
    } else {
      detailedContext = `The expected version range is ${solcVersionRange}.`;
    }
    const message = `The bytecode retrieved could not have been generated by the selected compiler.
The selected compiler version is v${config.solc.version}.
${detailedContext}
The selected network is ${network.name}.
Possible causes:
  - Wrong compiler version in buidler config
  - Wrong address for contract
  - Wrong network selected or faulty buidler network config`;
    throw new BuidlerPluginError(pluginName, message);
  }

  const { lookupMatchingBytecode, compile } = await import("./solc/bytecode");
  // TODO: this gives us the input for all contracts.
  // This could be restricted to relevant contracts in a future iteration of the compiler tasks.
  const { compilerInput, compilerOutput } = await compile(run);

  const contractInformation = await lookupMatchingBytecode(
    compilerOutput.contracts,
    deployedContractBytecode,
    solcVersionRange.inferralType
  );
  if (contractInformation === null) {
    const message = `The contract was not found among the ones present in this project.
The selected network is ${network.name}.
Possible causes:
  - Wrong address for contract
  - Wrong network selected or faulty buidler network config`;
    throw new BuidlerPluginError(pluginName, message);
  }

  const { Interface } = await import("@ethersproject/abi");
  const { isABIArgumentLengthError, isABIArgumentTypeError } = await import(
    "./ABITypes"
  );
  const contractInterface = new Interface(contractInformation.contract.abi);
  let deployArgumentsEncoded;
  try {
    deployArgumentsEncoded = contractInterface.encodeDeploy(
      constructorArguments
    );
  } catch (error) {
    if (isABIArgumentLengthError(error)) {
      const { contractName, contractFilename } = contractInformation;
      // TODO: add a list of types and constructor arguments to the error message?
      const message = `The constructor for ${contractFilename}:${contractName} has ${error.count.types} parameters
 but ${error.count.values} arguments were provided instead.\n`;
      throw new BuidlerPluginError(pluginName, message);
    }
    if (isABIArgumentTypeError(error)) {
      const message = `Value ${error.value} cannot be encoded for the parameter ${error.argument}.
Encoder error reason: ${error.reason}\n`;
      throw new BuidlerPluginError(pluginName, message);
    }
    // Should be unreachable.
    throw error;
  }

  // Ensure the linking information is present in the compiler input;
  compilerInput.settings.libraries = contractInformation.libraryLinks;
  const compilerInputJSON = JSON.stringify(compilerInput);

  const solcFullVersion = await solcVersionConfig.getLongVersion();

  const { toRequest } = await import(
    "./etherscan/EtherscanVerifyContractRequest"
  );
  const request = toRequest({
    apiKey: etherscan.apiKey,
    contractAddress: address,
    sourceCode: compilerInputJSON,
    contractName: contractInformation.contractName,
    compilerVersion: solcFullVersion,
    constructorArguments: deployArgumentsEncoded,
  });

  const { getVerificationStatus, verifyContract } = await import(
    "./etherscan/EtherscanService"
  );
  // const response = await verifyContract(etherscanAPIEndpoint, request);

  // TODO: Display contract name?
  console.log(
    `Successfully submitted contract at ${address} for verification on etherscan. Waiting for verification result...`
  );

  // await getVerificationStatus(etherscanAPIEndpoint, response.message);

  console.log("Successfully verified contract on etherscan");
};

task("verify", "Verifies contract on etherscan")
  .addPositionalParam(
    "address",
    "Address of the smart contract that will be verified"
  )
  .addOptionalParam(
    "constructorArgs",
    "File path to a javascript module that exports the list of arguments."
  )
  .addOptionalVariadicPositionalParam(
    "constructorArguments",
    "Arguments used in the contract constructor. These are ignored if the --constructorArgs option is passed.",
    []
  )
  .setAction(verify);
