import { describe, expect, it } from "bun:test"
import { createServer } from "node:net"
import { Bytes } from "@helios-lang/effect/Codecs"
import { Effect } from "effect"
import { Ledger, Network, TxBuilder, Uplc } from "@helios-lang/effect/Cardano"
import { BlockfrostLayer } from "./service.js"

const networkName = "preprod" as const
const projectId = "preprodYjh2RkMv6xqgWNKOBhuQ6hoazm0s0iFp"

const getFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()

    server.listen(0, "127.0.0.1", () => {
      const address = server.address()

      server.close((error) => {
        if (error) {
          reject(error)
        } else if (address !== null && typeof address === "object") {
          resolve(address.port)
        } else {
          reject(new Error("Unable to allocate test server port"))
        }
      })
    })
  })

const withBlockfrostServer = async <A>(
  handler: (request: Request) => Response,
  run: (baseUrl: string) => Promise<A>
): Promise<A> => {
  const port = await getFreePort()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (request) => {
      const url = new URL(request.url)

      if (url.pathname === "/blocks/latest") {
        return Response.json({
          height: 123,
          time: 1,
          slot: 1
        })
      }

      if (url.pathname === "/epochs/latest/parameters") {
        return Response.json({
          coins_per_utxo_size: 4310,
          collateral_percent: 150,
          cost_models: {
            PlutusV1: [],
            PlutusV2: []
          },
          cost_models_raw: {
            PlutusV1: [],
            PlutusV2: []
          },
          key_deposit: 2000000,
          max_collateral_inputs: 3,
          max_tx_ex_mem: 14000000,
          max_tx_ex_steps: 10000000000,
          max_tx_size: 16384,
          min_fee_a: 44,
          min_fee_b: 155381,
          price_mem: 0.0577,
          price_step: 0.0000721
        })
      }

      return handler(request)
    }
  })

  try {
    return await run(server.url.toString())
  } finally {
    await server.stop()
  }
}

describe("BlockfrostLive", () => {
  it("provides Network.FetchLiveBlockHeight", async () => {
    const height = await withBlockfrostServer(
      () => new Response("unexpected request", { status: 500 }),
      baseUrl =>
        Effect.runPromise(Network.FetchLiveBlockHeight.pipe(
          Effect.flatMap(fetchLiveBlockHeight => fetchLiveBlockHeight()),
          Effect.provide(
            BlockfrostLayer({
              networkName,
              projectId,
              baseUrl
            })
          )
        ))
    )

    expect(height).toBe(123)
  })

  it("provides TxBuilder.GetDatum", async () => {
    const datum = Uplc.Data.makeIntData(42)
    const datumHash = Ledger.DatumHash.hash(datum)
    const datumCbor = Bytes.toHex(Uplc.Data.encode(datum))
    const requestedPaths: string[] = []

    await withBlockfrostServer(
      (request) => {
        const url = new URL(request.url)

        requestedPaths.push(url.pathname)

        return Response.json({ cbor: datumCbor })
      },
      async (baseUrl) => {
        const fetchedDatum = await Effect.runPromise(TxBuilder.GetDatum.pipe(
          Effect.flatMap(getDatum => getDatum(datumHash)),
          Effect.provide(
            BlockfrostLayer({
              networkName,
              projectId,
              baseUrl
            })
          )
        ))

        expect(Uplc.Data.equals(fetchedDatum, datum)).toBe(true)
      }
    )

    expect(requestedPaths).toEqual([
      `/scripts/datum/${datumHash}/cbor`
    ])
  })

  it("maps missing datum responses to TxBuilder.DatumNotFound", async () => {
    const datumHash = Ledger.DatumHash.hash(Uplc.Data.makeIntData(404))

    await withBlockfrostServer(
      () => new Response("not found", { status: 404 }),
      async (baseUrl) => {
        const result = await Effect.runPromise(TxBuilder.GetDatum.pipe(
          Effect.flatMap(getDatum => getDatum(datumHash)),
          Effect.either,
          Effect.provide(
            BlockfrostLayer({
              networkName,
              projectId,
              baseUrl
            })
          )
        ))

        expect(result._tag).toBe("Left")

        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(TxBuilder.DatumNotFound)
        }
      }
    )
  })

  it("fetches all address transaction pages by default", async () => {
    const address
      = "addr_test1vz34ylm8ucm0xgq0a72n0r3w7yhgdudxxekvsae5j3w5d5sje670h" as Ledger.Address.Address
    const requestedSearches: string[] = []
    const txHashA = "a".repeat(64) as Ledger.TxHash.TxHash
    const txHashB = "b".repeat(64) as Ledger.TxHash.TxHash
    const txHashC = "c".repeat(64) as Ledger.TxHash.TxHash

    const txs = await withBlockfrostServer(
      (request) => {
        const url = new URL(request.url)

        requestedSearches.push(url.search)

        if (url.searchParams.get("page") === "1") {
          return Response.json([
            {
              tx_hash: txHashA,
              tx_index: 0,
              block_height: 10,
              block_time: 100
            },
            {
              tx_hash: txHashB,
              tx_index: 1,
              block_height: 11,
              block_time: 101
            }
          ])
        }

        return Response.json([
          {
            tx_hash: txHashC,
            tx_index: 0,
            block_height: 12,
            block_time: 102
          }
        ])
      },
      baseUrl =>
        Effect.runPromise(Network.Txs.pipe(
          Effect.flatMap(getTxs => getTxs({ address, count: 2 })),
          Effect.provide(
            BlockfrostLayer({
              networkName,
              projectId,
              baseUrl
            })
          )
        ))
    )

    expect(txs.map(tx => tx.hash)).toEqual([txHashA, txHashB, txHashC])
    expect(requestedSearches).toEqual([
      "?count=2&order=asc&page=1",
      "?count=2&order=asc&page=2"
    ])
  })

  it("fetches one descending address transaction page with block range options", async () => {
    const address
      = "addr_test1vz34ylm8ucm0xgq0a72n0r3w7yhgdudxxekvsae5j3w5d5sje670h" as Ledger.Address.Address
    const requestedSearches: string[] = []
    const txHashA = "a".repeat(64) as Ledger.TxHash.TxHash
    const txHashB = "b".repeat(64) as Ledger.TxHash.TxHash

    const txs = await withBlockfrostServer(
      (request) => {
        const url = new URL(request.url)

        requestedSearches.push(url.search)

        return Response.json([
          {
            tx_hash: txHashA,
            tx_index: 1,
            block_height: 99,
            block_time: 990
          },
          {
            tx_hash: txHashB,
            tx_index: 0,
            block_height: 98,
            block_time: 980
          }
        ])
      },
      baseUrl =>
        Effect.runPromise(Network.Txs.pipe(
          Effect.flatMap(getTxs =>
            getTxs({
              address,
              count: 2,
              fromBlock: 20,
              order: "desc",
              page: 3,
              toBlock: 100
            })
          ),
          Effect.provide(
            BlockfrostLayer({
              networkName,
              projectId,
              baseUrl
            })
          )
        ))
    )

    expect(txs.map(tx => tx.hash)).toEqual([txHashA, txHashB])
    expect(requestedSearches).toEqual([
      "?count=2&order=desc&page=3&from=20&to=100"
    ])
  })

  it("maps invalid datum CBOR to TxBuilder.DatumNotFound", async () => {
    const datumHash = Ledger.DatumHash.hash(Uplc.Data.makeIntData(400))

    await withBlockfrostServer(
      () => Response.json({ cbor: "not-cbor" }),
      async (baseUrl) => {
        const result = await Effect.runPromise(TxBuilder.GetDatum.pipe(
          Effect.flatMap(getDatum => getDatum(datumHash)),
          Effect.either,
          Effect.provide(
            BlockfrostLayer({
              networkName,
              projectId,
              baseUrl
            })
          )
        ))

        expect(result._tag).toBe("Left")

        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(TxBuilder.DatumNotFound)
        }
      }
    )
  })

  it("returns TxBuilder.DatumNotFound for a missing preprod datum hash", async () => {
    const datumHash
      = "0000000000000000000000000000000000000000000000000000000000000000" as Ledger.DatumHash.DatumHash

    const result = await Effect.runPromise(TxBuilder.GetDatum.pipe(
      Effect.flatMap(getDatum => getDatum(datumHash)),
      Effect.either,
      Effect.provide(
        BlockfrostLayer({
          networkName,
          projectId
        })
      )
    ))

    expect(result._tag).toBe("Left")

    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(TxBuilder.DatumNotFound)
    }
  })

  it("fetches a preprod datum by datum hash", async () => {
    const datumHash
      = "be10b490c35501e475186eb2a04bea1cb0aa87bb3ddfd44a7b0a7009bca57633" as Ledger.DatumHash.DatumHash
    const datum = Uplc.Data.makeIntData(12345678)

    const fetchedDatum = await Effect.runPromise(TxBuilder.GetDatum.pipe(
      Effect.flatMap(getDatum => getDatum(datumHash)),
      Effect.provide(
        BlockfrostLayer({
          networkName,
          projectId
        })
      )
    ))

    expect(Uplc.Data.equals(fetchedDatum, datum)).toBe(true)
  })

  it("provides Network.Params.params", async () => {
    const params = await Effect.runPromise(Network.Params.params.pipe(
      Effect.provide(
        BlockfrostLayer({
          networkName,
          projectId
        })
      )
    ))

    expect(params.txFeeFixed).toBeGreaterThan(0)
    expect(params.txFeePerByte).toBeGreaterThan(0)
    expect(params.costModelParamsV1.length).toBeGreaterThan(0)
    expect(params.costModelParamsV2.length).toBeGreaterThan(0)
    expect(params.refTipSlot).toBeGreaterThan(0)
    expect(params.refTipTime).toBeGreaterThan(0)
  })

  it("uses Blockfrost cost_models_raw ordering for cost model params", async () => {
    const params = await Effect.runPromise(Network.Params.params.pipe(
      Effect.provide(
        BlockfrostLayer({
          networkName,
          projectId
        })
      )
    ))

    const response = await fetch(
      `https://cardano-${networkName}.blockfrost.io/api/v0/epochs/latest/parameters`,
      {
        headers: {
          project_id: projectId
        }
      }
    )
    const body = await response.json() as {
      cost_models_raw: {
        PlutusV1: number[]
        PlutusV2: number[]
        PlutusV3?: number[]
      }
    }

    expect(params.costModelParamsV1).toEqual(body.cost_models_raw.PlutusV1)
    expect(params.costModelParamsV2).toEqual(body.cost_models_raw.PlutusV2)
    expect(params.costModelParamsV3).toEqual(body.cost_models_raw.PlutusV3 ?? [])
  })

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
