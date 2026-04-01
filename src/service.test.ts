import { describe, expect, it } from "bun:test"
import { Bytes } from "@helios-lang/effect/Codecs"
import { Effect } from "effect"
import { Ledger, Network } from "@helios-lang/effect/Cardano"
import { BlockfrostLayer } from "./service.js"

const networkName = "preprod" as const
const projectId = "preprodYjh2RkMv6xqgWNKOBhuQ6hoazm0s0iFp"

describe("BlockfrostLive", () => {
  it("getTx() returns same cbor as ledger serialization", async () => {
    const txId
      = "51819b162fc12523e3e80240f86c52e3a0a3fcca686790f6d616e275617a18c4" as Ledger.TxHash.TxHash

    const tx = await Effect.runPromise(Network.Tx.pipe(
      Effect.flatMap(getTx => getTx(txId)),
      Effect.provide(
        BlockfrostLayer({
          networkName,
          projectId
        })
      )
    ))

    const response = await fetch(
      `https://cardano-${networkName}.blockfrost.io/api/v0/txs/${txId}/cbor`,
      {
        headers: {
          project_id: projectId
        }
      }
    )
    const body = await response.json() as { cbor: string }

    expect(Bytes.toHex(Ledger.Tx.encode()(tx))).toBe(
      body.cbor
    )
  })

  it("getTx() works for txs using set encoding for signatures and inputs", async () => {
    const txId
      = "2b5395c8417739ecf6a8ce447c28f4a027951673ca8fbf6b8b9d77d99715b4a6" as Ledger.TxHash.TxHash

    const tx = await Effect.runPromise(Network.Tx.pipe(
      Effect.flatMap(getTx => getTx(txId)),
      Effect.provide(
        BlockfrostLayer({
          networkName,
          projectId
        })
      )
    ))

    expect(Ledger.Tx.hash(tx)).toBe(txId)
  })

  it("getTx() works for ebdf1c4596917e12c295ca66c349d69af1d09878a39320c46c3e62b5184d9054", async () => {
    const txId
      = "ebdf1c4596917e12c295ca66c349d69af1d09878a39320c46c3e62b5184d9054" as Ledger.TxHash.TxHash

    const tx = await Effect.runPromise(Network.Tx.pipe(
      Effect.flatMap(getTx => getTx(txId)),
      Effect.provide(
        BlockfrostLayer({
          networkName,
          projectId
        })
      )
    ))

    expect(Ledger.Tx.hash(tx)).toBe(txId)
  })

  it("fetches UTxOs at a known preprod address", async () => {
    const address
      = "addr_test1wq0a8zn7z544qvlxkt69g37thxrg8fepfuat9dcmnla2qjcysrmal" as Ledger.Address.Address

    const utxos = await Effect.runPromise(Network.UTxOsAt.pipe(
      Effect.flatMap(utxosAt => utxosAt(address)),
      Effect.provide(
        BlockfrostLayer({
          networkName,
          projectId
        })
      )
    ))

    expect(utxos.length).toBeGreaterThan(0)
    expect(utxos.every(utxo => utxo.output.address === address)).toBe(
      true
    )
  })

  it("getAddressTxs() returns at least one tx through Network.Txs", async () => {
    const address
      = "addr_test1vz34ylm8ucm0xgq0a72n0r3w7yhgdudxxekvsae5j3w5d5sje670h" as Ledger.Address.Address

    const txs = await Effect.runPromise(Network.Txs.pipe(
      Effect.flatMap(getTxs => getTxs({ address })),
      Effect.provide(
        BlockfrostLayer({
          networkName,
          projectId
        })
      )
    ))

    const knownTxs = [
      "5aaebfaa4994891e62f480f4105e4d8c148e2954a66501a637a851e2a6134f5c",
      "c146c3ac7716b489cee41f84a2a6daab72d29366a7d65123ce1e7d3d0821b905",
      "0d5722d3486c3ca7a482aa4c7653954c8133a9fb3efbe0b6c77cdb96e2439a2a"
    ] as const

    expect(txs.length).toBeGreaterThan(400)
    expect(
      knownTxs.every(
        knownTx => txs.some(tx => tx.hash === knownTx)
      )
    ).toBe(true)
  })
})
