import express from "express";
import url from "url";
import axios from "axios";
import cors from "cors";
import {
    AccountAddress,
    AccountInfo,
    AddressTransactions,
    EpochParams,
    PoolInfo,
    Tip,
    TransactionInfo,
    TransactionStatus,
} from "../client/src/entities/koios.entities";
import {
    ClaimableToken,
    GetPools,
    GetRewards,
    GetTokens,
    SanitizeAddress,
} from "../client/src/entities/vm.entities";
import {
    ExtendedMetadata,
    Metadata,
    PaymentTransactionHashRequest,
    TokenTransactionHashRequest,
} from "../client/src/entities/common.entities";
import { formatTokens } from "../client/src/services/utils.services";
require("dotenv").config();

const AIRDROP_ENABLED = process.env.AIRDROP_ENABLED || true;
const CARDANO_NETWORK = process.env.CARDANO_NETWORK || "testnet";
const CLAIM_ENABLED = process.env.CLAIM_ENABLED || true;
const CLOUDFLARE_PSK = process.env.CLOUDFLARE_PSK;
const PORT = process.env.PORT || 3000;
const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const VM_API_TOKEN =
    process.env.VM_API_TOKEN_TESTNET || process.env.VM_API_TOKEN;
const VM_URL = process.env.VM_URL_TESTNET || process.env.VM_URL;
const VM_KOIOS_URL = process.env.KOIOS_URL_TESTNET || process.env.KOIOS_URL;

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Serve static files for our React app
 */
app.use(express.static("../client/build"));

const server = app.listen(PORT, () => {
    console.log(`Server listening on ${PORT}`);
});

process.on("SIGTERM", () => {
    server.close(() => {
        console.log("Server shutting down");
    });
});

async function getFromVM<T>(params: any) {
    return (
        await axios.get<T>(`${VM_URL}/api.php?action=${params}`, {
            headers: { "X-API-Token": `${VM_API_TOKEN}` },
        })
    ).data;
}

async function getExtendedMetadata(
    metadataUrl: string
): Promise<ExtendedMetadata | undefined> {
    const metadata = (await axios.get<Metadata>(metadataUrl)).data;
    if (metadata?.extended) {
        const extendedMetadata = (
            await axios.get<ExtendedMetadata>(metadata.extended)
        ).data;
        return extendedMetadata;
    }
    return undefined;
}

async function getFromKoios<T>(action: string, params?: any) {
    if (params) {
        return (await axios.get<T>(`${VM_KOIOS_URL}/${action}?${params}`)).data;
    } else {
        return (await axios.get<T>(`${VM_KOIOS_URL}/${action}`)).data;
    }
}

async function postFromKoios<T>(action: string, params?: any) {
    if (params) {
        return (await axios.post<T>(`${VM_KOIOS_URL}/${action}`, params)).data;
    } else {
        return (await axios.post<T>(`${VM_KOIOS_URL}/${action}`)).data;
    }
}

async function getAccountsInfo(stakeAddress: string) {
    return getFromKoios<AccountInfo[]>(
        "account_info",
        `_address=${stakeAddress}`
    );
}

async function getAccountsAddresses(stakeAddress: string) {
    return getFromKoios<AccountAddress[]>(
        "account_addresses",
        `_address=${stakeAddress}`
    );
}

async function getEpochParams(epochNo: number) {
    return getFromKoios<EpochParams>(
	"epoch_params",
	`_epoch_no=${epochNo}`
    );
}

async function postPoolInfo(pools: string[]) {
    return postFromKoios<PoolInfo[]>("pool_info", { _pool_bech32_ids: pools });
}

async function getPools() {
    return getFromVM<GetPools>("get_pools");
}

async function getTokens() {
    return getFromVM<GetTokens>("get_tokens");
}

app.get("/getpools", async (req, res) => {
    const pools = await getPools();
    return res.status(200).send(pools);
});

app.get("/getsettings", async (req, res) => {
    const settings = await getFromVM("get_settings");
    return res.status(200).send(settings);
});

app.get("/health", (req: any, res: any) => {
    res.status(200).json({
        status: "UP",
    });
});

app.get("/healthz", async (req: any, res: any) => {
    if (CLOUDFLARE_PSK) {
        if (req.headers["x-cloudflare-psk"]) {
            const myPsk = req.headers["x-cloudflare-psk"];
            if (myPsk == CLOUDFLARE_PSK) {
                const authResponse = await getFromVM("is_authenticated");
                res.send(authResponse);
            } else {
                res.send({ error: "PSK invalid" });
            }
        } else {
            res.send({ error: "PSK missing" });
        }
    } else {
        res.status(200).json({
            status: "UP",
        });
    }
});

app.get("/features", (req: any, res: any) => {
    res.status(200).json({
        airdrop_enabled:
            typeof AIRDROP_ENABLED == "string"
                ? JSON.parse(AIRDROP_ENABLED.toLowerCase())
                : AIRDROP_ENABLED,
        claim_enabled:
            typeof CLAIM_ENABLED == "string"
                ? JSON.parse(CLAIM_ENABLED.toLowerCase())
                : CLAIM_ENABLED,
        network: CARDANO_NETWORK,
    });
});

app.get("/sanitizeaddr", async (req: any, res: any) => {
    const queryObject = url.parse(req.url, true).query;
    if (queryObject.address) {
        const stakingAddressResponse = await getFromVM<SanitizeAddress>(
            `sanitize_address&address=${queryObject.address}`
        );
        return res.send(stakingAddressResponse);
    } else {
        return res.send({ error: "Address seems invalid" });
    }
});

app.get("/getrewards", async (req: any, res: any) => {
    try {
        const queryObject = url.parse(req.url, true).query;
        const address = queryObject.address;

        if (!queryObject.address) throw new Error();

        const stakingAddressResponse = await getFromVM<SanitizeAddress>(
            `sanitize_address&address=${address}`
        );

        if (!stakingAddressResponse) return res.sendStatus(404);
        if (!stakingAddressResponse.staking_address) return res.sendStatus(404);

        const stakeAddress = stakingAddressResponse.staking_address;
        let getRewardsResponse = await getRewards(stakeAddress);
        const accountsInfo = await getAccountsInfo(stakeAddress);

        /**
         * try to get pool metadata
         * if fails, then leave without the metadata
         */
        let poolInfoObj: any = null;
        let logo = "";
        try {
            const accountInfo = accountsInfo[0];
            const poolsInfo = await postPoolInfo([accountInfo.delegated_pool]);
            if (!poolsInfo) throw new Error();
            const poolInfo = poolsInfo[0];
            const extendedMetadata = await getExtendedMetadata(
                poolInfo.meta_url
            );
            if (!extendedMetadata) throw new Error();
            poolInfoObj = {
                delegated_pool_name: poolInfo.meta_json.name,
                delegated_pool_description: poolInfo.meta_json.description,
                total_balance: formatTokens(accountInfo.total_balance, 6, 2),
                delegated_pool_ticker: poolInfo.meta_json.ticker,
            };
            logo = extendedMetadata.info.url_png_icon_64x64;
            poolInfoObj = {
                ...poolInfoObj,
                delegated_pool_logo: logo,
            };
        } catch (e) {}

        getRewardsResponse = {
            ...getRewardsResponse,
            pool_info: poolInfoObj,
        };

        return res.send(getRewardsResponse);
    } catch (error: any) {
        return res.status(500).send({ error: "An error occurred." });
    }
});

app.get("/getcustomrewards", async (req: any, res: any) => {
    try {
        const queryObject = url.parse(req.url, true).query;
        const { staking_address, session_id, selected } = queryObject;

        if (!staking_address) return res.sendStatus(400);

        const submitCustomReward = await getFromVM(
            `custom_request&staking_address=${staking_address}&session_id=${session_id}&selected=${selected}`
        );
        return res.send(submitCustomReward);
    } catch (e: any) {
        return res.status(500).send({ error: "An error occurred." });
    }
});

app.get("/txstatus", async (req, res) => {
    try {
        const queryObject = url.parse(req.url, true).query;
        const { request_id, session_id } = queryObject;

        if (!request_id || !session_id) return res.sendStatus(400);

        const txStatus = await getFromVM(
            `check_status_custom_request&request_id=${request_id}&session_id=${session_id}`
        );
        return res.send(txStatus);
    } catch (e: any) {
        return res.status(500).send({ error: "An error occurred." });
    }
});

app.get("/gettransactionstatus", async (req: any, res: any) => {
    try {
        const queryObject = url.parse(req.url, true).query;
        if (queryObject.txHash) {
            const getTransactionStatusResponse = await postFromKoios<
                TransactionStatus[]
            >(`tx_status`, { _tx_hashes: [queryObject.txHash] });
            res.send(getTransactionStatusResponse);
        } else {
            res.send({ error: "Tx hash seems invalid" });
        }
    } catch (error: any) {
        return res.status(500).send({ error: "An error occurred." });
    }
});

app.get("/getabsslot", async (req: any, res: any) => {
    try {
        const getTipResponse = await getFromKoios<Tip[]>(`tip`);
        res.send({
            abs_slot:
                getTipResponse && getTipResponse.length
                    ? getTipResponse[0].abs_slot
                    : 0,
        });
    } catch (error: any) {
        return res.status(500).send({ error: "An error occurred." });
    }
});

app.get("/getblock", async (req: any, res: any) => {
    try {
        const getTipResponse = await getFromKoios<Tip[]>(`tip`);
        res.send({
            block_no:
                getTipResponse && getTipResponse.length
                    ? getTipResponse[0].block_no
                    : 0,
        });
    } catch (error: any) {
        return res.status(500).send({ error: "An error occurred." });
    }
});

app.get("/gettip", async (req: any, res: any) => {
    try {
        const getTipResponse = await getFromKoios<Tip[]>(`tip`);
        res.send(getTipResponse[0]);
    } catch (error: any) {
        return res.status(500).send({ error: "An error occurred." });
    }
});

app.get("/getepochparams", async (req: any, res: any) => {
    try {
        const getTipResponse = await getFromKoios<Tip[]>(`tip`);
        const getEpochParamsResponse = await getEpochParams(
            getTipResponse && getTipResponse.length
	        ? getTipResponse[0].epoch_no
		: 0
	);
	res.send(getEpochParamsResponse);
    } catch (error: any) {
        return res.status(500).send({ error: "An error occurred." });
    }
});

app.post("/getpaymenttransactionhash", async (req: any, res: any) => {
    try {
        const requestBody = req.body as PaymentTransactionHashRequest;
        if (requestBody && requestBody.address && requestBody.address.length) {
            const bodyStakingAddressResponse = await getFromVM<SanitizeAddress>(
                `sanitize_address&address=${requestBody.address}`
            );
            if (
                bodyStakingAddressResponse &&
                bodyStakingAddressResponse.staking_address
            ) {
                const accountAddresses = await getAccountsAddresses(
                    bodyStakingAddressResponse.staking_address
                );
                const getTokenTxHashResponse = await postFromKoios<
                    AddressTransactions[]
                >(`address_txs`, {
                    _addresses: accountAddresses.map(
                        (accountAddress) => accountAddress.address
                    ),
                    _after_block_height: requestBody.afterBlock || 0,
                });
                if (getTokenTxHashResponse && getTokenTxHashResponse.length) {
                    const addressHashes = getTokenTxHashResponse.map(
                        (addressTx) => addressTx.tx_hash
                    );
                    const getTransactionsInfo = await postFromKoios<
                        TransactionInfo[]
                    >(`tx_info`, { _tx_hashes: addressHashes });
                    const fromStakingAddressResponse =
                        await getFromVM<SanitizeAddress>(
                            `sanitize_address&address=${requestBody.address}`
                        );
                    const toStakingAddressResponse =
                        await getFromVM<SanitizeAddress>(
                            `sanitize_address&address=${requestBody.toAddress}`
                        );
                    if (getTransactionsInfo && getTransactionsInfo.length) {
                        const filteredTxs = getTransactionsInfo.filter(
                            (txInfo) => {
                                const inputCorrect = txInfo.inputs.some(
                                    (input) => {
                                        const stakingAddressCorrect =
                                            input.stake_addr ===
                                            fromStakingAddressResponse.staking_address;
                                        return stakingAddressCorrect;
                                    }
                                );

                                const outputCorrect = txInfo.outputs.some(
                                    (output) => {
                                        const stakingAddressCorrect =
                                            output.stake_addr ===
                                            toStakingAddressResponse.staking_address;
                                        const amountCorrect =
                                            output.value ===
                                            requestBody.adaToSend.toString();
                                        return (
                                            amountCorrect &&
                                            stakingAddressCorrect
                                        );
                                    }
                                );

                                return inputCorrect && outputCorrect;
                            }
                        );
                        if (filteredTxs && filteredTxs.length) {
                            res.send({ txHash: filteredTxs[0].tx_hash });
                        } else {
                            res.send({ txHash: undefined });
                        }
                    }
                } else {
                    res.send({ txHash: undefined });
                }
            }
        } else {
            res.send({ error: "Address seems invalid" });
        }
    } catch (error: any) {
        return res.status(500).send({ error: "An error occurred." });
    }
});

app.post("/gettokentransactionhash", async (req: any, res: any) => {
    try {
        const requestBody = req.body as TokenTransactionHashRequest;
        if (requestBody && requestBody.address) {
            const getTokenTxHashResponse = await postFromKoios<
                AddressTransactions[]
            >(`address_txs`, {
                _addresses: [requestBody.address],
                _after_block_height: requestBody.afterBlock || 0,
            });
            if (getTokenTxHashResponse && getTokenTxHashResponse.length) {
                const addressHashes = getTokenTxHashResponse.map(
                    (addressTx) => addressTx.tx_hash
                );
                const getTransactionsInfo = await postFromKoios<
                    TransactionInfo[]
                >(`tx_info`, { _tx_hashes: addressHashes });
                const stakingAddressResponse = await getFromVM<SanitizeAddress>(
                    `sanitize_address&address=${requestBody.address}`
                );
                if (getTransactionsInfo && getTransactionsInfo.length) {
                    const filteredTxs = getTransactionsInfo.filter((txInfo) => {
                        return txInfo.outputs.some((output) => {
                            const stakingAddressCorrect =
                                output.stake_addr ===
                                stakingAddressResponse.staking_address;
                            let hasTokensCorrect: any[] = [];
                            output.asset_list.forEach((asset) => {
                                const token = requestBody.tokens.find(
                                    (token) =>
                                        token.policyId === asset.policy_id &&
                                        token.quantity === asset.quantity
                                );
                                if (token) {
                                    hasTokensCorrect.push(token);
                                }
                            });
                            return (
                                hasTokensCorrect.length &&
                                hasTokensCorrect.length ===
                                    output.asset_list.length &&
                                stakingAddressCorrect
                            );
                        });
                    });
                    if (filteredTxs && filteredTxs.length) {
                        res.send({ txHash: filteredTxs[0].tx_hash });
                    } else {
                        res.send({ txHash: undefined });
                    }
                }
            } else {
                res.send({ txHash: undefined });
            }
        } else {
            res.send({ error: "Address seems invalid" });
        }
    } catch (error: any) {
        return res.status(500).send({ error: "An error occurred." });
    }
});

async function getRewards(stakeAddress: string) {
    const getRewardsResponse = await getFromVM<GetRewards>(
        `get_rewards&staking_address=${stakeAddress}`
    );
    if (getRewardsResponse) {
        const tokens = await getTokens();
        if (tokens) {
            let claimableTokens: ClaimableToken[] = [];
            for (const key of Object.keys(
                getRewardsResponse.consolidated_promises
            )) {
                const token = tokens[key];
                if (token) {
                    claimableTokens.push({
                        assetId: key,
                        ticker: token.ticker,
                        logo: token.logo,
                        decimals: token.decimals,
                        amount: getRewardsResponse.consolidated_promises[key],
                    });
                }
            }
            for (const key of Object.keys(
                getRewardsResponse.consolidated_rewards
            )) {
                const token = tokens[key];
                if (token) {
                    claimableTokens.push({
                        assetId: key,
                        ticker: token.ticker,
                        logo: token.logo,
                        decimals: token.decimals,
                        amount: getRewardsResponse.consolidated_rewards[key],
                    });
                }
            }
            getRewardsResponse.claimable_tokens = claimableTokens;
        }
    }
    return getRewardsResponse;
}

// Fallback to React app
app.get("*", (req, res) => {
    res.sendFile("client/build/index.html", { root: "../" });
});