const { constants, expectRevert, time } = require("@openzeppelin/test-helpers");
const Controller = artifacts.require("Controller");
const Vault = artifacts.require("Vault");
const MockToken = artifacts.require("MockToken");
const NoopStrategy = artifacts.require("NoopStrategy");
const Storage = artifacts.require("Storage");
const HardRewards = artifacts.require("HardRewards");
const makeVault = require("./make-vault.js");
const { waitHours } = require("./Utils.js");
const BigNumber = require('bignumber.js');

contract("Controller Test", function (accounts) {
  describe("Deposit and Withdraw", function () {
    let governance = accounts[0];
    let rewardCollector = accounts[1];
    let farmer = accounts[2];
    let strategy = accounts[3];
    let hardWorker = accounts[4];

    let storage;
    let vault;
    let controller;
    let underlying;

    const farmerBalance = "95848503450";

    beforeEach(async function () {
      // create the underlying token
      underlying = await MockToken.new({ from: governance });
      await underlying.mint(farmer, farmerBalance, { from: governance });
      assert.equal(
        farmerBalance,
        (await underlying.balanceOf(farmer)).toString()
      );

      // set up controller
      storage = await Storage.new({ from: governance });
      controller = await Controller.new(storage.address, rewardCollector, {
        from: governance,
      });
      await storage.setController(controller.address, { from: governance });

      // set up the vault with 100% investment
      vault = await makeVault(storage.address, underlying.address, 100, 100, {
        from: governance,
      });

      // set up the strategy
      strategy = await NoopStrategy.new(
        storage.address,
        underlying.address,
        vault.address,
        { from: governance }
      );
    });

    it("Controller can set reward collector", async function () {
      assert.equal(await controller.feeRewardForwarder(), rewardCollector);

      // Setting the reward collector to governance
      await controller.setFeeRewardForwarder(governance);

      assert.equal(await controller.feeRewardForwarder(), governance);
    });

    it("Controller can add vault and strategy", async function () {
      // The vault does not exist before the strategy is added
      assert.isFalse(await controller.vaults(vault.address));

      assert.equal(await vault.strategy(), constants.ZERO_ADDRESS);

      // adding the vault and strategy pair
      await controller.addVaultAndStrategy(vault.address, strategy.address);

      // should have successfully set them
      assert.isTrue(await controller.vaults(vault.address));

      assert.equal(await vault.strategy(), strategy.address);
    });

    it("can add strategy for vault", async function () {
      let anotherNoopStrategy = await NoopStrategy.new(
        controller.address,
        underlying.address,
        vault.address,
        { from: governance }
      );

      // adding the vault and strategy pair
      await controller.addVaultAndStrategy(vault.address, strategy.address);
      assert.equal(strategy.address, await vault.strategy());

      // add strategy for the vault
      // strategy was already set, so we will fail without waiting for 12 hours
      // no announcement
      await expectRevert(
        vault.setStrategy(anotherNoopStrategy.address, { from: governance }),
        "The strategy exists and switch timelock did not elapse yet"
      );
      await vault.announceStrategyUpdate(anotherNoopStrategy.address, {
        from: governance,
      });
      // still not enough time elapsed
      await expectRevert(
        vault.setStrategy(anotherNoopStrategy.address, { from: governance }),
        "The strategy exists and switch timelock did not elapse yet"
      );
      await waitHours(12);
      await vault.setStrategy(anotherNoopStrategy.address, {
        from: governance,
      });
      assert.equal(anotherNoopStrategy.address, await vault.strategy());

      // deposit some tokens
      await underlying.approve(vault.address, farmerBalance, { from: farmer });
      await vault.deposit(farmerBalance, { from: farmer });

      // make the investment
      await vault.doHardWork({ from: governance });
      assert.equal(farmerBalance, await vault.balanceOf(farmer));
      assert.equal(0, await vault.availableToInvestOut());
      assert.equal(0, await vault.underlyingBalanceInVault());
      assert.equal(
        farmerBalance,
        await vault.underlyingBalanceWithInvestment()
      );

      // the investment should be in the strategy
      assert.equal(
        farmerBalance,
        await anotherNoopStrategy.investedUnderlyingBalance()
      );

      // add hard rewards
      let token = await MockToken.new({ from: governance });
      let hardRewards = await HardRewards.new(storage.address, token.address, {
        from: governance,
      });
      await controller.setHardRewards(hardRewards.address, {
        from: governance,
      });
      assert.equal(hardRewards.address, await controller.hardRewards());

      await controller.addHardWorker(hardWorker, {
        from: governance,
      });
      // improve the second strategy and trigger a re-invest
      let hint = await controller.getPricePerFullShare(vault.address);
      await controller.doHardWork(vault.address, hint, 100, 100, { from: hardWorker });

      await controller.removeHardWorker(hardWorker, {
        from: governance,
      });

      // the investment should be withdrawn from the strategy
      assert.equal(0, await strategy.investedUnderlyingBalance());
      assert.equal(
        farmerBalance,
        await anotherNoopStrategy.investedUnderlyingBalance()
      );
    });

    it("Governance can salvage", async function () {
      // deposit some tokens
      await underlying.transfer(controller.address, farmerBalance, {
        from: farmer,
      });
      assert.equal(
        farmerBalance,
        await underlying.balanceOf(controller.address)
      );

      await controller.salvage(underlying.address, farmerBalance, {
        from: governance,
      });
      assert.equal(farmerBalance, await underlying.balanceOf(governance));
    });

    it("Governance can salvage strategy", async function () {
      // deposit some tokens
      await underlying.transfer(strategy.address, farmerBalance, {
        from: farmer,
      });
      assert.equal(farmerBalance, await underlying.balanceOf(strategy.address));

      await controller.salvageStrategy(
        strategy.address,
        underlying.address,
        farmerBalance,
        { from: governance }
      );
      assert.equal(farmerBalance, await underlying.balanceOf(governance));
    });

    it("doHardWork fails on wrong hint", async function () {
      let hint = new BigNumber(await controller.getPricePerFullShare(vault.address));
      await expectRevert(
        controller.doHardWork(vault.address, hint.plus(new BigNumber("1")), 100, 100, { from: governance }),
        "share price deviation"
      );
      await expectRevert(
        controller.doHardWork(vault.address, hint.minus(new BigNumber("1")), 100, 100, { from: governance }),
        "share price deviation"
      );
      await expectRevert(
        controller.doHardWork(vault.address, hint.multipliedBy(new BigNumber("94")).dividedBy(new BigNumber("100")), 95, 100, { from: governance }),
        "share price deviation"
      );
      await expectRevert(
        controller.doHardWork(vault.address, hint.multipliedBy(new BigNumber("106")).dividedBy(new BigNumber("100")), 95, 100, { from: governance }),
        "share price deviation"
      );
      // no fail to confirm that passing is possible
      controller.doHardWork(vault.address, hint, 100, 100, { from: governance });
    });
  });
});
