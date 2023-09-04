import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BurryEscrow } from "../target/types/burry_escrow";
import { Big } from "@switchboard-xyz/common";
import { AggregatorAccount, AnchorWallet, SwitchboardProgram, SwitchboardTestContext, Callback, PermissionAccount } from "@switchboard-xyz/solana.js"
import { NodeOracle } from "@switchboard-xyz/oracle"
import { assert } from "chai";

export const solUsedSwitchboardFeed = new anchor.web3.PublicKey("GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR")

function delay(ms: number) {
  return new Promise( resolve => setTimeout(resolve, ms) );
}

describe.only("burry-escrow-vrf", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.AnchorProvider.env()
  const program = anchor.workspace.BurryEscrow as Program<BurryEscrow>;
  const payer = (provider.wallet as AnchorWallet).payer

  // ADDED CODE
  let switchboard: SwitchboardTestContext
  let oracle: NodeOracle

  before(async () => {
    switchboard = await SwitchboardTestContext.loadFromProvider(provider, {
      name: "Test Queue",
      // You can provide a keypair to so the PDA schemes dont change between test runs
      // keypair: SwitchboardTestContext.loadKeypair(SWITCHBOARD_KEYPAIR_PATH),
      queueSize: 10,
      reward: 0,
      minStake: 0,
      oracleTimeout: 900,
      // aggregators will not require PERMIT_ORACLE_QUEUE_USAGE before joining a queue
      unpermissionedFeeds: true,
      unpermissionedVrf: true,
      enableBufferRelayers: true,
      oracle: {
        name: "Test Oracle",
        enable: true,
        // stakingWalletKeypair: SwitchboardTestContext.loadKeypair(STAKING_KEYPAIR_PATH),
      },
    })

    oracle = await NodeOracle.fromReleaseChannel({
      chain: "solana",
      // use the latest testnet (devnet) version of the oracle
      releaseChannel: "testnet",
      // disables production capabilities like monitoring and alerts
      network: "localnet",
      rpcUrl: provider.connection.rpcEndpoint,
      oracleKey: switchboard.oracle.publicKey.toBase58(),
      // path to the payer keypair so the oracle can pay for txns
      secretPath: switchboard.walletPath,
      // set to true to suppress oracle logs in the console
      silent: false,
      // optional env variables to speed up the workflow
      envVariables: {
        VERBOSE: "1",
        DEBUG: "1",
        DISABLE_NONCE_QUEUE: "1",
        DISABLE_METRICS: "1",
      },
    })

    switchboard.oracle.publicKey

    // start the oracle and wait for it to start heartbeating on-chain
    await oracle.startAndAwait()
  })

  after(() => {
    oracle?.stop()
  })

  it("Create Burry Escrow Above Price", async () => {
    // fetch switchboard devnet program object
    const switchboardProgram = await SwitchboardProgram.load(
      "devnet",
      new anchor.web3.Connection("https://api.devnet.solana.com"),
      payer
    )
    const aggregatorAccount = new AggregatorAccount(switchboardProgram, solUsedSwitchboardFeed)

    // derive escrow state account
    const [escrowState] = await anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("MICHAEL BURRY"), payer.publicKey.toBuffer()],
      program.programId
    )
    console.log("Escrow Account: ", escrowState.toBase58())

    // fetch latest SOL price
    const solPrice: Big | null = await aggregatorAccount.fetchLatestValue()
    if (solPrice === null) {
      throw new Error('Aggregator holds no value')
    }
    const failUnlockPrice = solPrice.plus(10).toNumber()
    const amountToLockUp = new anchor.BN(100)

    // Send transaction
    try {
      const tx = await program.methods.deposit(
        amountToLockUp, 
        failUnlockPrice
      )
      .accounts({
        user: payer.publicKey,
        escrowAccount: escrowState,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([payer])
      .rpc()

      await provider.connection.confirmTransaction(tx, "confirmed")
      console.log("Your transaction signature", tx)

      // Fetch the created account
      const newAccount = await program.account.escrowState.fetch(
        escrowState
      )

      const escrowBalance = await provider.connection.getBalance(escrowState, "confirmed")
      console.log("On-chain unlock price:", newAccount.unlockPrice)
      console.log("Amount in escrow:", escrowBalance)

      // Check whether the data on-chain is equal to local 'data'
      assert(failUnlockPrice == newAccount.unlockPrice)
      assert(escrowBalance > 0)
    } catch (e) {
      console.log(e)
      assert.fail(e)
    }
  })

  it("Attempt to withdraw while price is below UnlockPrice", async () => {
    let didFail = false;

    // derive escrow address
    const [escrowState] = await anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("MICHAEL BURRY"), payer.publicKey.toBuffer()],
      program.programId
    )
    
    // send tx
    try {
      const tx = await program.methods.withdraw()
      .accounts({
        user: payer.publicKey,
        escrowAccount: escrowState,
        feedAggregator: solUsedSwitchboardFeed,
        systemProgram: anchor.web3.SystemProgram.programId
    })
      .signers([payer])
      .rpc()

      await provider.connection.confirmTransaction(tx, "confirmed")
      console.log("Your transaction signature", tx)

    } catch (e) {
      // verify tx returns expected error
      didFail = true;
      console.log(e.error.errorMessage)
      assert(e.error.errorMessage == 'Current SOL price is not above Escrow unlock price.')
    }

    assert(didFail)
  })

  it("Roll till you can withdraw", async () => {
        // derive escrow address
        const [escrowState] = await anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("MICHAEL BURRY"), payer.publicKey.toBuffer()],
          program.programId
        )

        const vrfSecret = anchor.web3.Keypair.generate()
        const [vrfClientKey] = anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from("VRFCLIENT"),
            payer.publicKey.toBytes(),
            escrowState.toBytes(),
            vrfSecret.publicKey.toBytes(),
          ],
          program.programId
        )
        console.log(`VRF Client: ${vrfClientKey}`)
    
        const vrfIxCoder = new anchor.BorshInstructionCoder(program.idl)
        const vrfClientCallback: Callback = {
          programId: program.programId,
          accounts: [
            // ensure all accounts in consumeRandomness are populated
            // { pubkey: payer.publicKey, isSigner: false, isWritable: true },
            { pubkey: escrowState, isSigner: false, isWritable: true },
            { pubkey: vrfClientKey, isSigner: false, isWritable: true },
            { pubkey: vrfSecret.publicKey, isSigner: false, isWritable: true },
          ],
          ixData: vrfIxCoder.encode("consumeRandomness", ""), // pass any params for instruction here
        }
    
        const queue = await switchboard.queue.loadData();
    
        // Create Switchboard VRF and Permission account
        const [vrfAccount] = await switchboard.queue.createVrf({
          callback: vrfClientCallback,
          authority: vrfClientKey, // vrf authority
          vrfKeypair: vrfSecret,
          enable: !queue.unpermissionedVrfEnabled, // only set permissions if required
        })
    
        // vrf data
        const vrf = await vrfAccount.loadData();
    
        console.log(`Created VRF Account: ${vrfAccount.publicKey}`)
    
        // derive the existing VRF permission account using the seeds
        const [permissionAccount, permissionBump] = PermissionAccount.fromSeed(
          switchboard.program,
          queue.authority,
          switchboard.queue.publicKey,
          vrfAccount.publicKey
        )
    
        const [payerTokenWallet] = await switchboard.program.mint.getOrCreateWrappedUser(
          switchboard.program.walletPubkey,
          { fundUpTo: 1.0 }
        );
    
        // initialize vrf client
        try {
          const tx = await program.methods.initVrfClient()
          .accounts({
            user: payer.publicKey,
            escrowAccount: escrowState,
            vrfState: vrfClientKey,
            vrf: vrfAccount.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId
          })
          .signers([payer])
          .rpc()
          
        } catch (e) {
          console.log(e)
          assert.fail()
        }
    
        let rolledDoubles = false
        while(!rolledDoubles){
          try {
            // Request randomness and roll dice
            const tx = await program.methods.getOutOfJail({
              switchboardStateBump: switchboard.program.programState.bump, 
              permissionBump})
            .accounts({
              vrfState: vrfClientKey,
              vrf: vrfAccount.publicKey,
              user: payer.publicKey,
              payerWallet: payerTokenWallet,
              escrowAccount: escrowState,
              oracleQueue: switchboard.queue.publicKey,
              queueAuthority: queue.authority,
              dataBuffer: queue.dataBuffer,
              permission: permissionAccount.publicKey,
              switchboardEscrow: vrf.escrow,
              programState: switchboard.program.programState.publicKey,

              switchboardProgram: switchboard.program.programId,
              recentBlockhashes: anchor.web3.SYSVAR_RECENT_BLOCKHASHES_PUBKEY,
              tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
              systemProgram: anchor.web3.SystemProgram.programId,
            })
            .signers([payer])
            .rpc()
    
            await provider.connection.confirmTransaction(tx, "confirmed")
            console.log(`Created VrfClient Account: ${vrfClientKey}`)
    
            // wait a few sec for switchboard to generate the random number and invoke callback ix
            console.log("Rolling Die...")

            let didUpdate = false;
            let vrfState = await program.account.vrfClientState.fetch(vrfClientKey)

            while(!didUpdate){
              console.log("Checking die...")
              vrfState = await program.account.vrfClientState.fetch(vrfClientKey);
              didUpdate = vrfState.timestamp.toNumber() > 0;
              await delay(1000)
            }

            console.log("Roll results - Die 1:", vrfState.dieResult1, "Die 2:", vrfState.dieResult2)
            if(vrfState.dieResult1 == vrfState.dieResult2){
              rolledDoubles = true
            } else {
              console.log("Resetting die...")
              await delay(5000)
            }
    
          } catch (e) {
            console.log(e)
            assert.fail()
          }
        }
    
        const tx = await program.methods.withdraw()
        .accounts({
          user: payer.publicKey,
          escrowAccount: escrowState,
          feedAggregator: solUsedSwitchboardFeed,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([payer])
        .rpc()
        
        await provider.connection.confirmTransaction(tx, "confirmed")
  })

});