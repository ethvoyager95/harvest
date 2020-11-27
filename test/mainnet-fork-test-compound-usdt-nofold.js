// This test is only invoked if MAINNET_FORK is set
if ( process.env.MAINNET_FORK ) {

  const Utils = require("./Utils.js");
  const MFC = require("./mainnet-fork-test-config.js");
  const { expectRevert, send, time } = require('@openzeppelin/test-helpers');
  const BigNumber = require('bignumber.js');
  const Controller = artifacts.require("Controller");
  const Storage = artifacts.require("Storage");
  const CompoundNoFoldStrategyUSDTMainnet = artifacts.require("CompoundNoFoldStrategyUSDTMainnet");
  const FeeRewardForwarder = artifacts.require("FeeRewardForwarder");
  const makeVault = require("./make-vault.js");

  // ERC20 interface
  const IERC20 = artifacts.require("IERC20");

  BigNumber.config({DECIMAL_PLACES: 0});

  contract("Mainnet Compound USDT Strategy", function(accounts){
    describe("Mainnet Compound USDT earnings", function (){

      // external contracts
      let underlying;

      // external setup
      let underlyingWhale = MFC.USDT_WHALE_ADDRESS;

      // parties in the protocol
      let governance = accounts[1];
      let farmer1 = accounts[3];

      // numbers used in tests
      let farmerBalance;

      // only used for ether distribution
      let etherGiver = accounts[9];

      // Core protocol contracts
      let storage;
      let controller;
      let vault;
      let strategy;
      let feeRewardForwarder;

      async function setupExternalContracts() {
        underlying = await IERC20.at(MFC.USDT_ADDRESS);
      }

      async function resetBalance() {
        // Give whale some ether to make sure the following actions are good
        await send.ether(etherGiver, underlyingWhale, "1000000000000000000");

        await underlying.transfer(farmer1, await underlying.balanceOf(underlyingWhale), {from: underlyingWhale});
        farmerBalance = await underlying.balanceOf(farmer1);
      }

      async function setupCoreProtocol() {
        // deploy storage
        storage = await Storage.new({ from: governance });

        feeRewardForwarder = await FeeRewardForwarder.new(storage.address, underlying.address, MFC.UNISWAP_V2_ROUTER02_ADDRESS, { from: governance });
        // set up controller
        controller = await Controller.new(storage.address, feeRewardForwarder.address, {
          from: governance,
        });

        await storage.setController(controller.address, { from: governance });

        // set up the vault with 100% investment
        vault = await makeVault(storage.address, underlying.address, 100, 100, {from: governance});

        // set up the strategy
        strategy = await CompoundNoFoldStrategyUSDTMainnet.new(
          storage.address,
          vault.address,
          { from: governance }
        );

        // link vault with strategy
        await controller.addVaultAndStrategy(vault.address, strategy.address, {from: governance});
      }

      beforeEach(async function () {
        await setupExternalContracts();
        await setupCoreProtocol();
        await resetBalance();
      });

      async function depositVault(_farmer, _underlying, _vault, _amount) {
        await _underlying.approve(_vault.address, _amount, { from: _farmer });
        await _vault.deposit(_amount, { from: _farmer });
        Utils.assertBNEq(_amount, await vault.balanceOf(_farmer));
      }

      it("A farmer investing underlying", async function () {

        let duration = 500000;
        let farmerOldBalance = new BigNumber(await underlying.balanceOf(farmer1));
        await depositVault(farmer1, underlying, vault, farmerBalance);
        await vault.doHardWork({from: governance});
        await Utils.advanceNBlock(10);

        await vault.doHardWork({from: governance});

        await time.increase(duration);
        await Utils.advanceNBlock(100);


        // this is bad code
        for (let i = 0; i < 24; i++) {
          await time.increase(duration);
          await Utils.advanceNBlock(100);
        }

        await vault.doHardWork({from: governance});

        await time.increase(duration);
        await Utils.advanceNBlock(10);
        await vault.doHardWork({from: governance});
        await vault.withdraw(farmerBalance, {from: farmer1});
        let farmerNewBalance = new BigNumber(await underlying.balanceOf(farmer1));
        // Farmer gained money
        Utils.assertBNGt(farmerNewBalance, farmerOldBalance);
      });
    });
  });
}
