import {
    FetchHttpClient,
    HttpBody,
    HttpClient,
    HttpClientResponse
} from "@effect/platform"
import { Ledger, Network, Uplc } from "@helios-lang/effect/Cardano"
import { Bytes } from "@helios-lang/effect/Codecs"
import { Effect, Either, Layer, ParseResult, Schema } from "effect"
import { Assets, TxOutput, UTxO } from "./schemas"

export type NetworkName = "mainnet" | "preprod" | "preview"

export interface Config {
    readonly networkName: NetworkName
    readonly projectId: string
    readonly baseUrl?: string | undefined
}

const MAX_UTXOS_PER_PAGE = 100
const MAX_RATE_LIMIT_RETRIES = 7

const TxSchema = Schema.declare<Ledger.Tx.Tx>(
    (input): input is Ledger.Tx.Tx =>
        typeof input === "object" &&
        input !== null &&
        "body" in input &&
        "witnesses" in input &&
        "isValid" in input
)

const TxOutputDatumSchema = Schema.declare<
    Ledger.TxOutputDatum.TxOutputDatum | undefined
>(
    (input): input is Ledger.TxOutputDatum.TxOutputDatum | undefined =>
        input === undefined ||
        (typeof input === "object" &&
            input !== null &&
            ("hash" in input ||
                "bytes" in input ||
                "int" in input ||
                "list" in input ||
                "map" in input ||
                "fields" in input))
)

const ReferenceScriptSchema = Schema.declare<
    NonNullable<Ledger.TxOutput.TxOutput["refScript"]>
>(
    (input): input is NonNullable<Ledger.TxOutput.TxOutput["refScript"]> =>
        typeof input === "object" &&
        input !== null &&
        "version" in input &&
        "root" in input &&
        (((input as { version?: unknown }).version === 2 ||
            (input as { version?: unknown }).version === 3) &&
            (input as { root?: unknown }).root instanceof Uint8Array)
)


const BlockfrostDatumFields = Schema.Struct({
    data_hash: Schema.NullOr(Ledger.DatumHash.DatumHash),
    inline_datum: Schema.NullOr(Schema.String)
})

const BlockfrostDatum = Schema.transformOrFail(
    BlockfrostDatumFields,
    TxOutputDatumSchema,
    {
        strict: true,
        decode: ({ data_hash, inline_datum }, _, ast) => {
            if (inline_datum !== null) {
                return toParseResult(Uplc.Data.decode(inline_datum), ast, inline_datum)
            }

            if (data_hash !== null) {
                return ParseResult.succeed({ hash: data_hash })
            }

            return ParseResult.succeed(undefined)
        },
        encode: (datum) => {
            if (datum === undefined) {
                return ParseResult.succeed({
                    data_hash: null,
                    inline_datum: null
                })
            }

            if ("hash" in datum) {
                return ParseResult.succeed({
                    data_hash: datum.hash,
                    inline_datum: null
                })
            }

            return ParseResult.succeed({
                data_hash: null,
                inline_datum: Bytes.toHex(Uplc.Data.encode(datum))
            })
        }
    }
)

const BlockfrostErrorResponse = Schema.Struct({
    status_code: Schema.Int
})

const BlockfrostReferenceScriptResponse = Schema.transformOrFail(
    Schema.Struct({
        cbor: Schema.String
    }),
    ReferenceScriptSchema,
    {
        strict: true,
        decode: ({ cbor }, _, ast) => {
            const decoded = Uplc.Script.decodeRoot(cbor)

            if (Either.isLeft(decoded)) {
                return ParseResult.fail(
                    new ParseResult.Type(ast, cbor, decoded.left.message)
                )
            }

            switch (decoded.right.uplcVersion) {
                case "1.0.0":
                    return ParseResult.succeed({
                        version: 2 as const,
                        root: decoded.right.root
                    })
                case "1.1.0":
                    return ParseResult.succeed({
                        version: 3 as const,
                        root: decoded.right.root
                    })
                default:
                    return ParseResult.fail(
                        new ParseResult.Type(
                            ast,
                            cbor,
                            `unexpected Blockfrost script version ${decoded.right.uplcVersion}`
                        )
                    )
            }
        },
        encode: (script) =>
            ParseResult.succeed({
                cbor: Bytes.toHex(Uplc.Script.encode(script))
            })
    }
)

const BlockfrostSubmitResponse = Schema.transformOrFail(
    Schema.Union(
        Schema.String,
        Schema.Struct({
            txId: Schema.optional(Schema.String),
            txID: Schema.optional(Schema.String),
            hash: Schema.optional(Schema.String)
        })
    ),
    Ledger.TxHash.TxHash,
    {
        strict: true,
        decode: (value, _, ast) => {
            const txHash =
                typeof value === "string"
                    ? value
                    : value.txId ?? value.txID ?? value.hash

            if (txHash === undefined) {
                return ParseResult.fail(
                    new ParseResult.Type(
                        ast,
                        value,
                        "expected submit response tx hash"
                    )
                )
            }

            return toParseResult(
                Schema.decodeUnknownEither(Ledger.TxHash.TxHash)(txHash),
                ast,
                value
            )
        },
        encode: (txHash) => ParseResult.succeed(txHash)
    }
)

const BlockfrostAddressUtxosRequestQuery = Schema.Struct({
    count: Schema.NumberFromString,
    order: Schema.Literal("asc"),
    page: Schema.NumberFromString
})

const BlockfrostHeaders = Schema.Struct({
    project_id: Schema.String
})

const BlockfrostSubmitHeaders = Schema.Struct({
    project_id: Schema.String,
    "content-type": Schema.Literal("application/cbor")
})

const BlockfrostSubmitRequest = Schema.transformOrFail(
    Schema.Uint8ArrayFromSelf,
    TxSchema,
    {
        strict: true,
        decode: (_, __, ast) =>
            ParseResult.fail(
                new ParseResult.Forbidden(
                    ast,
                    undefined,
                    "Decoding Blockfrost submit requests is not supported"
                )
            ),
        encode: (tx) =>
            ParseResult.succeed(Bytes.toUint8Array(Ledger.Tx.encode()(tx)))
    }
)

export const BlockfrostService = (config: Config) =>
    Layer.mergeAll(
        Layer.succeed(Network.IsMainnet, config.networkName === "mainnet"),
        Layer.effect(
            Network.UTxO,
            Effect.gen(function* () {
                const client = yield* HttpClient.HttpClient

                return (ref: Ledger.UTxORef.UTxORef) =>
                    executeWithRateLimitRetry(() =>
                        client.get(
                            `${getBaseUrl(config)}/txs/${Ledger.UTxORef.txHash(ref)}/utxos`,
                            {
                                headers: makeHeaders(config),
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
                                const decoded = yield* decodeUnknown(
                                    Schema.Struct({ outputs: Schema.Array(TxOutput) }),
                                    body
                                )
                                const outputIndex = Ledger.UTxORef.index(ref)
                                const output =
                                    decoded.outputs[outputIndex]

                                if (!output) {
                                    return yield* Effect.fail(
                                        new Network.UTxONotFound(ref)
                                    )
                                }

                                const utxo = yield* makeUTxOFromBlockfrost(
                                    client,
                                    config,
                                    {
                                        tx_hash: Ledger.UTxORef.txHash(ref),
                                        output_index: outputIndex,
                                        ...output
                                    }
                                )

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
            })
        ),
        Layer.effect(
            Network.UTxOsAt,
            Effect.gen(function* () {
                const client = yield* HttpClient.HttpClient

                return (address: Ledger.Address.Address) =>
                    Effect.gen(function* () {
                        const utxos: Ledger.UTxO.UTxO[] = []
                        let page = 1

                        while (true) {
                            const response = yield* executeWithRateLimitRetry(
                                () =>
                                    client.get(
                                        `${getBaseUrl(config)}/addresses/${address}/utxos?${makeAddressUtxosQuery(page)}`,
                                        {
                                            headers: makeHeaders(config),
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

                            if (isBlockfrostErrorResponse(body)) {
                                return utxos
                            }

                            const pageItems = yield* decodeUnknown(
                                Schema.Array(UTxO),
                                body
                            )
                            const pageUtxos = yield* Effect.all(
                                pageItems.map((item) =>
                                    makeUTxOFromBlockfrost(client, config, item)
                                )
                            )

                            utxos.push(...pageUtxos)

                            if (pageItems.length < MAX_UTXOS_PER_PAGE) {
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
            })
        ),
        Layer.effect(
            Network.Submit,
            Effect.gen(function* () {
                const client = yield* HttpClient.HttpClient

                return (tx: Ledger.Tx.Tx) =>
                    executeWithRateLimitRetry(() =>
                        client.post(`${getBaseUrl(config)}/tx/submit`, {
                            headers: makeSubmitHeaders(config),
                            body: HttpBody.uint8Array(
                                Schema.encodeSync(BlockfrostSubmitRequest)(tx),
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
                                const submittedHash = yield* decodeUnknown(
                                    BlockfrostSubmitResponse,
                                    body
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
            })
        )
    )

export const Blockfrost = (config: Config) =>
    BlockfrostService(config).pipe(Layer.provide(FetchHttpClient.layer))

export const provideBlockfrostService = (config: Config) =>
    Effect.provide(Blockfrost(config))

const executeWithRateLimitRetry = (
    request: () => Effect.Effect<HttpClientResponse.HttpClientResponse, any, never>,
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

// TODO: can this be converted into a Schema?
const makeUTxOFromBlockfrost = (
    client: HttpClient.HttpClient,
    config: Config,
    raw: UTxO
) =>
    Effect.gen(function* () {
        const refScript = yield* loadRefScript(
            client,
            config,
            raw.reference_script_hash
        )
        
        const datum = yield* decodeUnknown(BlockfrostDatum, {
            data_hash: raw.data_hash,
            inline_datum: raw.inline_datum
        })

        return Ledger.UTxO.make(
            Ledger.UTxORef.make(raw.tx_hash, BigInt(raw.output_index)),
            Ledger.TxOutput.make({
                address: raw.address,
                assets: raw.amount,
                ...(datum !== undefined ? { datum } : {}),
                ...(refScript !== undefined ? { refScript } : {})
            })
        )
    })

const loadRefScript = (
    client: HttpClient.HttpClient,
    config: Config,
    scriptHash: string | null
): Effect.Effect<
    Ledger.TxOutput.TxOutput["refScript"],
    Network.ConnectionError | Network.UnexpectedFormat,
    never
> => {
    if (scriptHash === null) {
        return Effect.succeed(undefined)
    }

    return executeWithRateLimitRetry(() =>
        client.get(`${getBaseUrl(config)}/scripts/${scriptHash}/cbor`, {
            headers: makeHeaders(config),
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

                return yield* decodeUnknown(
                    BlockfrostReferenceScriptResponse,
                    body
                )
            })
        ),
        Effect.catchTag(
            "ResponseError",
            (e) => new Network.ConnectionError(e.message)
        )
    )
}

const makeAddressUtxosQuery = (page: number) =>
    new URLSearchParams(
        Schema.encodeSync(BlockfrostAddressUtxosRequestQuery)({
            count: MAX_UTXOS_PER_PAGE,
            order: "asc",
            page
        })
    ).toString()

const makeHeaders = (config: Config) =>
    Schema.encodeSync(BlockfrostHeaders)({
        project_id: config.projectId
    })

const makeSubmitHeaders = (config: Config) =>
    Schema.encodeSync(BlockfrostSubmitHeaders)({
        project_id: config.projectId,
        "content-type": "application/cbor"
    })

const isBlockfrostErrorResponse = (body: unknown): boolean =>
    Either.isRight(Schema.decodeUnknownEither(BlockfrostErrorResponse)(body))

const getBaseUrl = (config: Config): string =>
    (config.baseUrl ??
        `https://cardano-${config.networkName}.blockfrost.io/api/v0`
    ).replace(/\/+$/, "")

const decodeUnknown = <A, I, R>(
    schema: Schema.Schema<A, I, R>,
    input: unknown
) => {
    const result = Schema.decodeUnknownEither(
        schema as Schema.Schema<A, I, never>
    )(input)

    if (Either.isLeft(result)) {
        return Effect.fail(new Network.UnexpectedFormat(result.left.message))
    }

    return Effect.succeed(result.right)
}

const toParseResult = <A>(
    result: Either.Either<A, { readonly issue?: ParseResult.ParseIssue; readonly message?: string }>,
    ast: any,
    actual: unknown
) =>
    Either.isLeft(result)
        ? ParseResult.fail(
              result.left.issue ??
                  new ParseResult.Type(ast, actual, result.left.message)
          )
        : ParseResult.succeed(result.right)

export { FetchHttpClient }
