import * as wasm from "@emurgo/cardano-serialization-lib-asmjs";
import { NetworkId } from "src/entities/common.entities";
import * as CommonService from "src/services/common";

let Buffer = require("buffer").Buffer;

declare global {
  interface Window {
    cardano: CIP0030Wallets;
  }
}

if (typeof window !== "undefined") {
  window.cardano = window.cardano as CIP0030Wallets;
}

export enum WalletKeys {
  anetawallet = "anetawallet",
  cardwallet = "cardwallet",
  eternl = "eternl",
  flint = "flint",
  gerowallet = "gerowallet",
  nami = "nami",
  nufi = "nufi",
  typhoncip30 = "typhoncip30",
  yoroi = "yoroi",
  LodeWallet = "LodeWallet",
}

const ERROR = {
  NOT_CONNECTED: "Wallet not connected",
  TX_TOO_BIG: "Transaction too big",
  FAILED_PROTOCOL_PARAMETER: "FAILED_PROTOCOL_PARAMETER",
};

export interface CIP0030API {
  getBalance: () => Promise<any>;
  signData: (address: string, payload: any) => Promise<any>;
  signTx: (tx: any, partialSign?: boolean) => Promise<any>;
  submitTx: (tx: any) => Promise<any>;
  getUtxos: (amount?: number, paginate?: any) => Promise<string[]>;
  getUsedAddresses: () => Promise<wasm.Address[]>;
  getUnusedAddresses: () => Promise<wasm.Address[]>;
  getChangeAddress: () => Promise<string>;
  getRewardAddresses: () => Promise<wasm.Address[]>;
  getNetworkId: () => Promise<number>;
  experimental?: {
    [key: string]: any;
  };
}

export interface CIP0030Wallets {
  [key: string]: CIP0030Wallet;
}

export interface CIP0030Wallet {
  enable: () => Promise<CIP0030API>;
  isEnabled: () => Promise<boolean>;
  apiVersion: string;
  name: string;
  icon: string;
  api: CIP0030API;
}

class WalletApi {
  wallet: CIP0030Wallet | undefined;

  constructor(walletApi: CIP0030Wallet | undefined) {
    this.wallet = walletApi;
  }

  async disconnectWallet() {
    this.wallet = undefined;
  }

  async isEnabled() {
    return await this.wallet?.isEnabled();
  }

  async enable(walletKey: WalletKeys) {
    if (!(await this.isEnabled())) {
      try {
        return await window.cardano[WalletKeys[walletKey]].enable();
      } catch (error: any) {
        throw new Error(error.message || error.info);
      }
    }
  }

  async getAddress() {
    if (!this.isEnabled() || !this.wallet) throw ERROR.NOT_CONNECTED;

    const addresses = await this.wallet.api.getUsedAddresses();
    const addressHex = Buffer.from(addresses[0] as any, "hex");

    const address = wasm.BaseAddress.from_address(
      wasm.Address.from_bytes(addressHex)
    )!
      .to_address()
      .to_bech32();

    return address;
  }

  async getNetworkId() {
    if (!this.isEnabled() || !this.wallet) throw ERROR.NOT_CONNECTED;

    let networkId = await this.wallet.api.getNetworkId();
    return {
      network: networkId as NetworkId,
    };
  }

  async getBalance() {
    if (!this.isEnabled() || !this.wallet) throw ERROR.NOT_CONNECTED;

    let networkId = await this.getNetworkId();
    let protocolParameter = await CommonService.getEpochParams();

    // const valueCBOR = await this.wallet.api.getBalance()
    // const value = wasm.Value.from_bytes(Buffer.from(valueCBOR, "hex"))

    const utxos = await this.wallet.api.getUtxos();
    if (utxos) {
      const parsedUtxos = utxos.map(
        (utxo: any | { [Symbol.toPrimitive](hint: "string"): string }) =>
          wasm.TransactionUnspentOutput.from_bytes(Buffer.from(utxo, "hex"))
      );

      let countedValue = wasm.Value.new(wasm.BigNum.from_str("0"));
      parsedUtxos.forEach((element) => {
        countedValue = countedValue.checked_add(element.output().amount());
      });
      const minAda = wasm.min_ada_required(
        countedValue,
        false,
        wasm.BigNum.from_str(protocolParameter.min_utxo_value.toString())
      );

      const availableAda = countedValue.coin().checked_sub(minAda);
      const lovelace = availableAda.to_str();

      return {
        lovelace: lovelace,
        assets: "",
      };
    }
    return {};
  }

  async transferAda(paymentAddress: string, adaAmount: string) {
    if (!this.wallet) return;

    const [protocolParameters, tip] = await Promise.all([
      CommonService.getEpochParams(),
      CommonService.getTip(),
    ]);

    const changeAddress =
      await (this.wallet?.api.getChangeAddress() as Promise<string>);
    // Cast according to wallet
    if (changeAddress) {
      const account = this.wallet.api;
      // change address
      const address = await account.getChangeAddress();
      const changeAddress = wasm.Address.from_bytes(
        Buffer.from(address, "hex")
      ).to_bech32();

      // config
      const txConfig = wasm.TransactionBuilderConfigBuilder.new()
        .coins_per_utxo_word(
          wasm.BigNum.from_str(String(protocolParameters.coins_per_utxo_size))
        )
        .fee_algo(
          wasm.LinearFee.new(
            wasm.BigNum.from_str(String(protocolParameters.min_fee_a)),
            wasm.BigNum.from_str(String(protocolParameters.min_fee_b))
          )
        )
        .key_deposit(
          wasm.BigNum.from_str(String(protocolParameters.key_deposit))
        )
        .pool_deposit(
          wasm.BigNum.from_str(String(protocolParameters.pool_deposit))
        )
        .max_tx_size(protocolParameters.max_tx_size)
        .max_value_size(protocolParameters.max_tx_size)
        .prefer_pure_change(true)
        .build();

      // builder
      const txBuilder = wasm.TransactionBuilder.new(txConfig);

      /** valid for one hour (3600) */
      txBuilder.set_ttl_bignum(
        wasm.BigNum.from_str((tip.abs_slot + 3600).toString())
      );

      // outputs
      txBuilder.add_output(
        wasm.TransactionOutputBuilder.new()
          .with_address(wasm.Address.from_bech32(paymentAddress))
          .next()
          .with_value(wasm.Value.new(wasm.BigNum.from_str(adaAmount)))
          .build()
      );

      // convert utxos from wallet connector
      const utxosFromWalletConnector = (await account.getUtxos()).map((utxo) =>
        wasm.TransactionUnspentOutput.from_bytes(Buffer.from(utxo, "hex"))
      );

      // create TransactionUnspentOutputs for 'add_inputs_from' function
      const utxoOutputs = wasm.TransactionUnspentOutputs.new();
      utxosFromWalletConnector.map((currentUtxo) =>
        utxoOutputs.add(currentUtxo)
      );

      // inputs with coin selection
      // 0 for LargestFirst, 1 RandomImprove 2,3 Mutli asset
      txBuilder.add_inputs_from(utxoOutputs, 0);
      txBuilder.add_change_if_needed(wasm.Address.from_bech32(changeAddress));

      const txBody = txBuilder.build();
      const transaction = wasm.Transaction.new(
        txBuilder.build(),
        wasm.TransactionWitnessSet.new()
      );

      let witness;
      try {
        witness = await account.signTx(
          Buffer.from(transaction.to_bytes(), "hex").toString("hex")
        );
      } catch (error: any) {
        throw new Error(error.message || error.info);
      }

      const signedTx = wasm.Transaction.new(
        txBody,
        wasm.TransactionWitnessSet.from_bytes(Buffer.from(witness, "hex")),
        undefined // transaction metadata
      );

      const txHash = await account.submitTx(
        Buffer.from(signedTx.to_bytes()).toString("hex")
      );

      return txHash;
    }
    return undefined;
  }

  async getUtxos(utxos: any[]) {
    let Utxos = utxos.map(
      (
        u:
          | WithImplicitCoercion<string>
          | { [Symbol.toPrimitive](hint: "string"): string }
      ) => wasm.TransactionUnspentOutput.from_bytes(Buffer.from(u, "hex"))
    );
    let UTXOS = [];
    for (let utxo of Utxos) {
      let assets = this._utxoToAssets(utxo);

      UTXOS.push({
        txHash: Buffer.from(
          utxo.input().transaction_id().to_bytes(),
          "hex"
        ).toString("hex"),
        txId: utxo.input().index(),
        amount: assets,
      });
    }
    return UTXOS;
  }

  _utxoToAssets(utxo: wasm.TransactionUnspentOutput) {
    let value = utxo.output().amount();
    const assets = [];
    assets.push({
      unit: "lovelace",
      quantity: value.coin().to_str(),
    });
    const multiAsset = value.multiasset();
    if (multiAsset) {
      const multiAssets = multiAsset.keys();
      for (let j = 0; j < multiAssets.len(); j++) {
        const policy = multiAssets.get(j);
        const policyAssets = multiAsset.get(policy);

        if (policyAssets == null) continue;

        const assetNames = policyAssets.keys();
        for (let k = 0; k < assetNames.len(); k++) {
          const policyAsset = assetNames.get(k);
          const quantity = policyAssets.get(policyAsset);

          if (quantity == null) continue;

          const asset =
            Buffer.from(policy.to_bytes()).toString("hex") +
            "." +
            Buffer.from(policyAsset.name()).toString("ascii");

          assets.push({
            unit: asset,
            quantity: quantity.to_str(),
          });
        }
      }
    }
    return assets;
  }
}

export default WalletApi;
