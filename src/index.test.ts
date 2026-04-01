import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { Ledger, Network } from "@helios-lang/effect/Cardano"
import { Blockfrost } from "./index.js"

describe("BlockfrostLive", () => {
    it("fetches UTxOs at a known preprod address", async () => {
        const address =
            "addr_test1wq0a8zn7z544qvlxkt69g37thxrg8fepfuat9dcmnla2qjcysrmal" as Ledger.Address.Address

        const utxos = await Effect.runPromise(Network.UTxOsAt.pipe(
            Effect.flatMap((utxosAt) => utxosAt(address)),
            Effect.provide(
                Blockfrost({
                    networkName: "preprod",
                    projectId: "preprod0pfhlHkVoJ3Bkwn3Ap3lP1VAysoIqwFl"
                })
            )
        ))

        expect(utxos.length).toBeGreaterThan(0)
        expect(utxos.every((utxo) => utxo.output.address === address)).toBe(
            true
        )
    })
})
