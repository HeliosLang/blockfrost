import {
    FetchHttpClient,
    HttpBody,
    HttpClient,
    HttpClientError,
    HttpClientResponse
} from "@effect/platform"
import { Ledger, Network, Uplc } from "@helios-lang/effect/Cardano"
import { Bytes } from "@helios-lang/effect/Codecs"
import { Effect, Either, Layer, Schema } from "effect"
import {
    ResolveScript,
    ResolveScriptError,
    SubmitResponse,
    TxOutput,
    UTxO
} from "./schemas.js"

export type NetworkName = "mainnet" | "preprod" | "preview"

export interface Config {
    readonly networkName: NetworkName
    readonly projectId: string
    readonly baseUrl?: string | undefined
}

const MAX_UTXOS_PER_PAGE = 100
const MAX_RATE_LIMIT_RETRIES = 7

export const BlockfrostService = (config: Config) => Layer.unwrapEffect(Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const baseUrl = (config.baseUrl ??
        `https://cardano-${config.networkName}.blockfrost.io/api/v0`
    ).replace(/\/+$/, "")

        const resolveScript = (scriptHash: string) =>
            executeWithRateLimitRetry(() =>
                client.get(`${baseUrl}/scripts/${scriptHash}/cbor`, {
                    headers: {
                        project_id: config.projectId
                    },
                    accept: "application/json"
                })
            ).pipe(
                Effect.flatMap((response) =>
                    Effect.gen(function* () {
                        if (response.status >= 400) {
                            return yield* Effect.fail(
                                new Network.ConnectionError(yield* response.text)
                            )
                        }

                        const body = yield* response.json

                        const { cbor } = yield* Schema.decodeUnknown(
                            Schema.Struct({
                                cbor: Schema.String
                            })
                        )(body).pipe(
                            Effect.mapError(
                                (e) => new Network.UnexpectedFormat(e.message)
                            )
                        )

                        const v3Script = Uplc.Script.decode(3)(cbor)

                        if (v3Script._tag === "Right") {
                            return v3Script.right
                        }

                        return yield* Uplc.Script.decode(2)(cbor).pipe(
                            Either.mapLeft(
                                (e) => new Network.UnexpectedFormat(e.message)
                            )
                        )
                    })
                ),
                Effect.catchTag(
                    "ResponseError",
                    (e) => new Network.ConnectionError(e.message)
                ),
                Effect.mapError(
                    (error) =>
                        new ResolveScriptError({
                            cause: error,
                            message: error.message
                        })
                )
            )

        return Layer.mergeAll(
            Layer.succeed(Network.IsMainnet, config.networkName === "mainnet"),
            Layer.effect(
                Network.UTxO,
                Effect.succeed(
                    (
                        ref: Ledger.UTxORef.UTxORef
                    ): Effect.Effect<
                        Ledger.UTxO.UTxO,
                        | Network.ConnectionError
                        | Network.UnexpectedFormat
                        | Network.UTxONotFound
                        | Network.UTxOAlreadySpent,
                        never
                    > =>
                        executeWithRateLimitRetry(() =>
                            client.get(
                                `${baseUrl}/txs/${Ledger.UTxORef.txHash(ref)}/utxos`,
                                {
                                    headers: {
                                        project_id: config.projectId,
                                    },
                                    accept: "application/json"
                                }
                            )
                        ).pipe(
                            Effect.flatMap((response) =>
                                Effect.gen(function* () {
                                    if (response.status === 404) {
                                        return yield* Effect.fail(
                                            new Network.UTxONotFound(ref)
                                        )
                                    }

                                    if (response.status >= 400) {
                                        return yield* Effect.fail(
                                            new Network.ConnectionError(
                                                yield* response.text
                                            )
                                        )
                                    }

                                    const body = yield* response.json
                                    const decoded = yield* Schema.decodeUnknown(
                                        Schema.Struct({
                                            outputs: Schema.Array(TxOutput)
                                        })
                                    )(body).pipe(
                                        Effect.provideService(
                                            ResolveScript,
                                            resolveScript
                                        ),
                                        Effect.mapError(
                                            (e) =>
                                                new Network.UnexpectedFormat(
                                                    e.message
                                                )
                                        )
                                    )

                                    const outputIndex = Ledger.UTxORef.index(ref)
                                    const output = decoded.outputs.at(outputIndex)

                                    if (!output) {
                                        return yield* Effect.fail(
                                            new Network.UTxONotFound(ref)
                                        )
                                    }

                                    const utxo = Ledger.UTxO.make(ref, output)

                                    if (typeof output.consumed_by_tx === "string") {
                                        return yield* Effect.fail(
                                            new Network.UTxOAlreadySpent(
                                                utxo,
                                                output.consumed_by_tx
                                            )
                                        )
                                    }

                                    return utxo
                                })
                            ),
                            Effect.catchTag(
                                "ResponseError",
                                (e) => new Network.ConnectionError(e.message)
                            )
                        )
                )
            ),
            Layer.effect(
                Network.UTxOsAt,
                Effect.succeed(
                    (
                        address: Ledger.Address.Address
                    ): Effect.Effect<
                        Ledger.UTxO.UTxO[],
                        Network.ConnectionError | Network.UnexpectedFormat,
                        never
                    > =>
                        Effect.gen(function* () {
                            const utxos: Ledger.UTxO.UTxO[] = []
                            let page = 1

                            while (true) {
                                const query = new URLSearchParams({
                                        count: MAX_UTXOS_PER_PAGE.toString(),
                                        order: "asc",
                                        page: page.toString()
                                    }
                                ).toString()

                                const response = yield* executeWithRateLimitRetry(
                                    () =>
                                        client.get(
                                            `${baseUrl}/addresses/${address}/utxos?${query}`,
                                            {
                                                headers: {
                                                    project_id: config.projectId
                                                },
                                                accept: "application/json"
                                            }
                                        )
                                )

                                if (response.status === 404) {
                                    return utxos
                                }

                                if (response.status >= 400) {
                                    return yield* Effect.fail(
                                        new Network.ConnectionError(
                                            yield* response.text
                                        )
                                    )
                                }

                                const body = yield* response.json

                                const pageUtxos = yield* Schema.decodeUnknown(
                                    Schema.Array(UTxO)
                                )(body).pipe(
                                    Effect.provideService(
                                        ResolveScript,
                                        resolveScript
                                    ),
                                    Effect.mapError(
                                        (e) =>
                                            new Network.UnexpectedFormat(
                                                e.message
                                            )
                                    )
                                )

                                utxos.push(...pageUtxos)

                                if (pageUtxos.length < MAX_UTXOS_PER_PAGE) {
                                    return utxos
                                }

                                page += 1
                            }
                        }).pipe(
                            Effect.catchTag(
                                "ResponseError",
                                (e) => new Network.ConnectionError(e.message)
                            )
                        )
                )
            ),
            Layer.effect(
                Network.Submit,
                Effect.succeed((tx: Ledger.Tx.Tx) =>
                    executeWithRateLimitRetry(() =>
                        client.post(`${baseUrl}/tx/submit`, {
                            headers: {
                                project_id: config.projectId,
                                "content-type": "application/cbor"
                            },
                            body: HttpBody.uint8Array(
                                Bytes.toUint8Array(
                                    Ledger.Tx.encode({ full: false })(tx)
                                ),
                                "application/cbor"
                            )
                        })
                    ).pipe(
                        Effect.flatMap((response) =>
                            Effect.gen(function* () {
                                if (response.status !== 200) {
                                    return yield* Effect.fail(
                                        new Network.SubmitTxFailed(
                                            yield* response.text,
                                            tx
                                        )
                                    )
                                }

                                const body = yield* response.json
                                const submittedHash = yield* Schema.decodeUnknown(
                                    SubmitResponse
                                )(body).pipe(
                                    Effect.mapError(
                                        (e) =>
                                            new Network.UnexpectedFormat(
                                                e.message
                                            )
                                    )
                                )

                                if (submittedHash !== Ledger.Tx.hash(tx)) {
                                    return yield* Effect.fail(
                                        new Network.UnexpectedFormat(
                                            `Blockfrost submit hash mismatch (${submittedHash})`
                                        )
                                    )
                                }

                                return tx
                            })
                        ),
                        Effect.catchTag(
                            "ResponseError",
                            (e) => new Network.ConnectionError(e.message)
                        )
                    )
                )
            )
        )
    }))

export const Blockfrost = (config: Config) =>
    BlockfrostService(config).pipe(Layer.provide(FetchHttpClient.layer))

export const provideBlockfrostService = (config: Config) =>
    Effect.provide(Blockfrost(config))

const executeWithRateLimitRetry = (
    request: () => Effect.Effect<
        HttpClientResponse.HttpClientResponse,
        HttpClientError.HttpClientError,
        never
    >,
    attempt = 0
): Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    Network.ConnectionError,
    never
> =>
    request().pipe(
        Effect.catchTags({
            RequestError: (e) => new Network.ConnectionError(e.message),
            ResponseError: (e) => new Network.ConnectionError(e.message)
        }),
        Effect.flatMap((response) => {
            if (response.status !== 429) {
                return Effect.succeed(response)
            }

            if (attempt >= MAX_RATE_LIMIT_RETRIES) {
                return Effect.fail(
                    new Network.ConnectionError(
                        "Blockfrost rate limit exceeded"
                    )
                )
            }

            return Effect.sleep(Math.pow(2, attempt) * 100).pipe(
                Effect.zipRight(executeWithRateLimitRetry(request, attempt + 1))
            )
        })
    )
    
