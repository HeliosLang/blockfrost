import { Context, Data, Effect, ParseResult, Schema } from "effect"
import { Ledger, Uplc} from "@helios-lang/effect/Cardano"
import { Bytes } from "@helios-lang/effect/Codecs"

export class ResolveScriptError extends Data.TaggedError("Blockfrost.ResolveScriptError")<{
    readonly cause?: unknown, 
    readonly message: string
}> {}

export class ResolveScript extends Context.Tag("Blockfrost.ResolveScript")<ResolveScript, (scriptHash: string) => Effect.Effect<Uplc.Script.Script<2 | 3>, ResolveScriptError>>() {}

export const AssetClass = Schema.transformOrFail(
    Schema.String,
    Ledger.AssetClass.AssetClass,
    {
        strict: true,
        decode: (unit) => {
            if (unit === "lovelace") {
                return ParseResult.succeed(Ledger.AssetClass.ADA)
            }

            return ParseResult.succeed(unit)
        },
        encode: (assetClass) =>
            ParseResult.succeed(
                assetClass === Ledger.AssetClass.ADA ? "lovelace" : assetClass
            )
    }
)

export const Assets = Schema.transformOrFail(
    Schema.Array(Schema.Struct({
        unit: AssetClass,
        quantity: Schema.BigInt
    })),
    Ledger.Assets.Assets,
    {
        strict: true,
        decode: (amounts) => {
            const assets: Record<string, bigint> = {}

            for (const { unit, quantity } of amounts) {
                const assetClass = unit

                assets[assetClass] = quantity
            }

            return ParseResult.succeed(assets)
        },
        encode: (assets) =>
            ParseResult.succeed(
                Object.entries(assets).map(([unit, quantity]) => ({
                    unit: unit as Ledger.AssetClass.AssetClass,
                    quantity
                }))
            )
    }
)

export const RequestHeaders = Schema.Struct({
    project_id: Schema.String
})



export const SubmitResponse = Schema.transformOrFail(
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

            return ParseResult.succeed(txHash)
        },
        encode: (txHash) => ParseResult.succeed(txHash)
    }
)

const TxOutputMetadata = Schema.typeSchema(Schema.Struct({
    collateral: Schema.optional(Schema.Boolean),
    consumed_by_tx: Schema.optional(Schema.NullOr(Ledger.TxHash.TxHash))
}))

export const TxOutput = Schema.transformOrFail(
    Schema.Struct({
        address: Ledger.Address.Address,
        amount: Assets,
        data_hash: Schema.NullOr(Ledger.DatumHash.DatumHash),
        inline_datum: Schema.NullOr(Schema.String),
        reference_script_hash: Schema.NullOr(Schema.String),
        collateral: Schema.optional(Schema.Boolean),
        consumed_by_tx: Schema.optional(Schema.NullOr(Ledger.TxHash.TxHash))
    }),
    Schema.extend(Schema.typeSchema(Ledger.TxOutput.TxOutput), TxOutputMetadata),
    {
        strict: true,
        decode: (raw, _, _ast) =>
            Effect.gen(function* () {
                const resolveScript = yield* ResolveScript
                const datum = yield* Schema.decodeUnknown(TxOutputDatum)({
                    data_hash: raw.data_hash,
                    inline_datum: raw.inline_datum
                }).pipe(
                    Effect.mapError((error) => error.issue)
                )
                const refScript =
                    raw.reference_script_hash === null
                        ? undefined
                        : yield* resolveScript(raw.reference_script_hash).pipe(
                            Effect.mapError(
                                (error) =>
                                    new ParseResult.Type(
                                        Schema.String.ast,
                                        raw.reference_script_hash,
                                        error.message
                                    )
                            )
                        )

                return {
                    ...Ledger.TxOutput.make({
                    address: raw.address,
                    assets: raw.amount,
                    ...(datum !== undefined ? { datum } : {}),
                    ...(refScript !== undefined ? { refScript } : {})
                    }),
                    ...(raw.collateral !== undefined
                        ? { collateral: raw.collateral }
                        : {}),
                    ...(raw.consumed_by_tx !== undefined
                        ? { consumed_by_tx: raw.consumed_by_tx }
                        : {})
                }
            }),
        encode: (output) =>
            ParseResult.succeed({
                address: output.address,
                amount: output.assets,
                data_hash:
                    output.datum && "hash" in output.datum
                        ? output.datum.hash
                        : null,
                inline_datum:
                    output.datum && !("hash" in output.datum)
                        ? Bytes.toHex(Uplc.Data.encode(output.datum))
                        : null,
                ...(output.collateral !== undefined
                    ? { collateral: output.collateral }
                    : {}),
                ...(output.consumed_by_tx !== undefined
                    ? { consumed_by_tx: output.consumed_by_tx }
                    : {}),
                reference_script_hash: output.refScript
                    ? Uplc.Script.hash(output.refScript)
                    : null
            }),
    }
)

export const TxOutputDatum = Schema.transformOrFail(
    Schema.Struct({
        data_hash: Schema.NullOr(Ledger.DatumHash.DatumHash),
        inline_datum: Schema.NullOr(Schema.String)
    }),
    Schema.Union(Schema.typeSchema(Ledger.TxOutputDatum.TxOutputDatum), Schema.Undefined),
    {
        strict: true,
        decode: ({ data_hash, inline_datum }, _, ast) => {
            if (inline_datum !== null) {
                const inlineDatum = Uplc.Data.decode(inline_datum)

                if (inlineDatum._tag == "Left") {
                    return ParseResult.fail(new ParseResult.Type(ast, inline_datum, inlineDatum.left.message))
                } else {
                    return ParseResult.succeed(inlineDatum.right)
                }
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

export const UTxO = Schema.transformOrFail(
    Schema.extend(Schema.encodedSchema(TxOutput), Schema.Struct({
        tx_hash: Ledger.TxHash.TxHash,
        output_index: Schema.Int
    })),
    Schema.typeSchema(Ledger.UTxO.UTxO),
    {
        strict: true,
        decode: (raw, _, _ast) =>
            Effect.gen(function* () {
                const output = yield* Schema.decodeUnknown(TxOutput)({
                    address: raw.address,
                    amount: raw.amount,
                    data_hash: raw.data_hash,
                    inline_datum: raw.inline_datum,
                    reference_script_hash: raw.reference_script_hash,
                    ...(raw.collateral !== undefined
                        ? { collateral: raw.collateral }
                        : {}),
                    ...(raw.consumed_by_tx !== undefined
                        ? { consumed_by_tx: raw.consumed_by_tx }
                        : {})
                }).pipe(
                    Effect.mapError((error) => error.issue)
                )

                return Ledger.UTxO.make(
                    Ledger.UTxORef.make(
                        raw.tx_hash,
                        BigInt(raw.output_index)
                    ),
                    output
                )
            }),
        encode: (utxo) =>
            Effect.gen(function* () {
                const output = yield* Schema.encode(TxOutput)(utxo.output).pipe(
                    Effect.mapError((error) => error.issue)
                )

                return {
                    ...output,
                    tx_hash: Ledger.UTxORef.txHash(utxo.ref),
                    output_index: Ledger.UTxORef.index(utxo.ref)
                }
            })
    }
)

export type UTxO = Schema.Schema.Type<typeof UTxO>
