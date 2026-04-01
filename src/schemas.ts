import { ParseResult, Schema } from "effect"
import { Ledger } from "@helios-lang/effect/Cardano"

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

export const TxOutput = Schema.Struct({
    address: Ledger.Address.Address,
    amount: Assets,
    data_hash: Schema.NullOr(Ledger.DatumHash.DatumHash),
    inline_datum: Schema.NullOr(Schema.String),
    reference_script_hash: Schema.NullOr(Schema.String),
    collateral: Schema.optional(Schema.Boolean),
    consumed_by_tx: Schema.optional(Schema.NullOr(Ledger.TxHash.TxHash))
})

export const UTxO = Schema.extend(TxOutput, Schema.Struct({
    tx_hash: Ledger.TxHash.TxHash,
    output_index: Schema.Int
}))

export type UTxO = Schema.Schema.Type<typeof UTxO>