import * as nemSDK from 'nem-sdk';
import { Account, AccountHttp, Address, AggregateTransaction, Deadline, InnerTransaction, Listener, LockFundsTransaction, Mosaic, NetworkType, PlainMessage, PublicAccount, QueryParams, SignedTransaction, TransactionHttp, TransactionType, TransferTransaction, UInt64, XEM } from 'nem2-sdk';
import { Initiator } from './Initiator';
import { IReadyTransaction } from './ReadyTransaction';
import { SHA256 } from './hashFunctions';
import { HashFunction } from './hashFunctions/HashFunction';
import uniqBy = require('lodash/uniqBy');

const nem = nemSDK.default;
// TODO: add tx hash of creation
class Apostille {

  private transactions: IReadyTransaction[] = [];
  private Apostille: Account = new Account();
  private created: boolean = false;
  private creationAnnounced: boolean = false;
  private generatorAccount: Account = new Account();
  private creatorAccount;
  private hash;

  constructor(
    public readonly seed: string,
    private genratorPrivateKey: string,
    public readonly networkType: NetworkType,
  ) {
    if (!nem.utils.helpers.isPrivateKeyValid(genratorPrivateKey)) {
      throw new Error('!invalid private key');
    }
    const keyPair = nem.crypto.keyPair.create(this.genratorPrivateKey);
    this.generatorAccount = Account.createFromPrivateKey(this.genratorPrivateKey, this.networkType);
    // hash the seed for the apostille account
    const hashSeed = SHA256.hash(this.seed);
    // signe the hashed seed to get the private key
    const privateKey = nem.utils.helpers.fixPrivateKey(keyPair.sign(hashSeed).toString());
    // create the HD acccount (appostille)
    this.Apostille = Account.createFromPrivateKey(privateKey, this.networkType);
  }

  public async create(
    initiatorAccount: Initiator,
    rawData: string,
    mosaics: Mosaic[] | Mosaic[] = [],
    hashFunction?: HashFunction,
  ): Promise<void> {
    if (initiatorAccount.network !== this.networkType) {
      throw new Error('Netrowk type miss matched!');
    }
    // check if the apostille was already created locally or on chain
    await this.isAnnouced(this);
    if (this.created) {
      this.created = true;
      throw new Error('you have already created this apostille');
    }
    this.creatorAccount = initiatorAccount;
    let creationTransaction: TransferTransaction;
    let readyCreation: IReadyTransaction;
    // first we create the creation transaction as a transfer transaction
    if (hashFunction) {
      // for digital files it's a good idea to hash the content of the file
      // but can be used for other types of information for real life assets
      this.hash = hashFunction.signedHashing(rawData, initiatorAccount.account.privateKey);
      creationTransaction = TransferTransaction.create(
        Deadline.create(),
        Address.createFromRawAddress(this.Apostille.address.plain()),
        mosaics,
        PlainMessage.create(this.hash),
        this.networkType,
      );
    } else {
      creationTransaction = TransferTransaction.create(
        Deadline.create(),
        Address.createFromRawAddress(this.Apostille.address.plain()),
        mosaics,
        PlainMessage.create(rawData),
        this.networkType,
      );
    }
    // we prepare the transaction to push it in the array
    if (initiatorAccount.multisigAccount) {
      if (initiatorAccount.complete) {
        // aggregate compleet transaction
        readyCreation = {
          initiator: initiatorAccount,
          transaction: creationTransaction,
          type: TransactionType.AGGREGATE_COMPLETE,
        };
      } else {
        // aggregate bounded
        readyCreation = {
          initiator: initiatorAccount,
          transaction: creationTransaction,
          type: TransactionType.AGGREGATE_BONDED,
        };
      }
    } else {
      // transafer transaction
      readyCreation = {
        initiator: initiatorAccount,
        transaction: creationTransaction,
        type: TransactionType.TRANSFER,
      };
    }
    this.transactions.push(readyCreation);
    this.created = true;
  }

  public async update(
    initiatorAccount: Initiator,
    message: string,
    mosaics: Mosaic[] | Mosaic[] = [],
  ): Promise<void> {
    if (initiatorAccount.network !== this.networkType) {
      throw new Error('Netrowk type miss matched!');
    }
    if (!this.created) {
      // we test locally first to avoid testing on chain evrytime we update
      await this.isAnnouced(this);
      if (!this.created) {
        throw new Error('Apostille not created yet!');
      }
    }
    // we create the update transaction
    const updateTransaction = TransferTransaction.create(
      Deadline.create(),
      Address.createFromRawAddress(this.Apostille.address.plain()),
      mosaics,
      PlainMessage.create(message),
      this.networkType,
    );
    // we prepare the transaction to push it in the array
    let readyUpdate: IReadyTransaction;
    if (initiatorAccount.multisigAccount) {
      if (initiatorAccount.complete) {
        // aggregate compleet transaction
        readyUpdate = {
          initiator: initiatorAccount,
          transaction: updateTransaction,
          type: TransactionType.AGGREGATE_COMPLETE,
        };
      } else {
        // aggregate bounded
        readyUpdate = {
          initiator: initiatorAccount,
          transaction: updateTransaction,
          type: TransactionType.AGGREGATE_BONDED,
        };
      }
    } else {
      // transafer transaction
      readyUpdate = {
        initiator: initiatorAccount,
        transaction: updateTransaction,
        type: TransactionType.TRANSFER,
      };
    }
    this.transactions.push(readyUpdate);
  }

  public async announce(urls?: string): Promise<void> {
    await this.isAnnouced(this);
    if (!this.created) {
      throw new Error('Apostille not created yet!');
    }
    let transactionHttp: TransactionHttp;
    let listener: Listener;
    if (urls) {
      if (this.networkType === NetworkType.MAIN_NET || this.networkType === NetworkType.TEST_NET) {
        console.warn('To fetch a far far away transaction a historical node is needed');
      }
      transactionHttp = new TransactionHttp(urls);
      listener = new Listener(urls);
    } else {
      if (this.networkType === NetworkType.MAIN_NET) {
        transactionHttp = new TransactionHttp('http://88.99.192.82:7890');
        listener = new Listener('http://88.99.192.82:7890');
      } else if (this.networkType === NetworkType.TEST_NET) {
        transactionHttp = new TransactionHttp('http://104.128.226.60:7890');
        listener = new Listener('http://104.128.226.60:7890');
      } else if (this.networkType === NetworkType.MIJIN) {
        throw new Error('Missing Endpoint argument!');
      } else {
        transactionHttp = new TransactionHttp('http://api.beta.catapult.mijin.io:3000');
        listener = new Listener('http://api.beta.catapult.mijin.io:3000');
      }
    }
    let readyTransfer: IReadyTransaction[] = [];
    this.transactions.forEach((readyTransaction) => {
      if (readyTransaction.type === TransactionType.TRANSFER) {
        // if transfer transaction keep piling them in for an aggregate aggregate
        readyTransfer.push(readyTransaction);
      } else if (readyTransaction.type === TransactionType.AGGREGATE_COMPLETE) {
        // if aggregate complete check if trensfer transaction has transaction to announce
        if (readyTransfer.length > 0) {
          this.announceTransfer(readyTransfer, transactionHttp);
          readyTransfer = [];
        }
        const aggregateTransaction = AggregateTransaction.createComplete(
          Deadline.create(),
          [
            readyTransaction.transaction.toAggregate(readyTransaction.initiator.multisigAccount),
          ],
          NetworkType.MIJIN_TEST,
          [],
        );
        // then announce aggregate compleet
        let signedTransaction: SignedTransaction;
        if (readyTransaction.initiator.cosignatories) {
          // if we have cosignatories that needs to sign
          signedTransaction = readyTransaction.initiator.account.signTransactionWithCosignatories(
            aggregateTransaction,
            readyTransaction.initiator.cosignatories);
        } else {
          // it should be a 1-n account
          signedTransaction = readyTransaction.initiator.account.sign(aggregateTransaction);
        }
        transactionHttp.announce(signedTransaction).subscribe(
          (x) => console.log(x),
          (err) => console.error(err));

      } else if (readyTransaction.type === TransactionType.AGGREGATE_BONDED) {
        if (readyTransfer.length > 0) {
          this.announceTransfer(readyTransfer, transactionHttp);
          readyTransfer = [];
        }
        // we need a lock transaction for the aggregate bounded
        const aggregateTransaction = AggregateTransaction.createBonded(
          Deadline.create(),
          [
            readyTransaction.transaction.toAggregate(readyTransaction.initiator.multisigAccount),
          ],
          NetworkType.MIJIN_TEST,
          [],
        );
        let signedTransaction: SignedTransaction;
        if (readyTransaction.initiator.cosignatories) {
          // if we have cosignatories that needs to sign
          signedTransaction = readyTransaction.initiator.account.signTransactionWithCosignatories(
            aggregateTransaction,
            readyTransaction.initiator.cosignatories);
        } else {
          // it should be a 1-n account
          signedTransaction = readyTransaction.initiator.account.sign(aggregateTransaction);
        }
        // the lock need the signed aggregate transaction
        const lockFundsTransaction = LockFundsTransaction.create(
          Deadline.create(),
          XEM.createRelative(10),
          UInt64.fromUint(480),
          signedTransaction,
          NetworkType.MIJIN_TEST);
        // we sign the lock
        const signedLock = readyTransaction.initiator.account.sign(lockFundsTransaction);
        // announce the lock then the aggregate bounded
        listener.open().then(() => {

          transactionHttp.announce(signedLock).subscribe(
              (x) => console.log(x),
              (err) => console.error(err));
          listener.confirmed(readyTransaction.initiator.account.address)
              .filter((transaction) => transaction.transactionInfo !== undefined
                  && transaction.transactionInfo.hash === signedLock.hash)
              .flatMap(() => transactionHttp.announceAggregateBonded(signedTransaction))
              .subscribe(
                (announcedAggregateBonded) => console.log(announcedAggregateBonded),
                (err) => console.error(err));
        });
      }
    });
    // finally check if the transafer transaction arraay has transactions to announce
    if (readyTransfer.length > 0) {
      this.announceTransfer(readyTransfer, transactionHttp);
      readyTransfer = [];
      // empty the array
    }
    // empty the array
    this.transactions = [];
  }

  get privateKey(): string {
    return this.Apostille.privateKey;
  }

  get publicKey(): string {
    return this.Apostille.publicKey;
  }

  get address(): Address {
    return this.Apostille.address;
  }

  get hashSigner(): PublicAccount {
    return this.generatorAccount.publicAccount;
  }

  get hdAccount(): PublicAccount {
    return PublicAccount.createFromPublicKey(this.publicKey, this.networkType);
  }

  get apostilleHash(): string {
    return this.hash;
  }

  public async isCreated(): Promise<boolean> {
    await this.isAnnouced(this);
    return this.created;
  }

  public isAnnouced(apostille?: Apostille): boolean {
    // check if the apostille account has any transaction
    if (apostille) {
      let accountHttp ;
      if (this.networkType === NetworkType.MAIN_NET) {
        accountHttp  = new AccountHttp('http://88.99.192.82:7890');
      } else if (this.networkType === NetworkType.TEST_NET) {
        accountHttp  = new AccountHttp('http://104.128.226.60:7890');
      } else if (this.networkType === NetworkType.MIJIN) {
        throw new Error('Missing Endpoint argument!');
      } else {
        accountHttp  = new AccountHttp('http://api.beta.catapult.mijin.io:3000');
      }

      accountHttp.transactions(
        apostille.hdAccount,
        new QueryParams(10),
      ).subscribe(
          (transactions) => {
            if (transactions.length) {
              this.created = true;
              this.creationAnnounced = true;
              return true;
            } else {
              return this.creationAnnounced;
            }
          },
          (err) => {
            console.error(err);
            return this.creationAnnounced;
          },
      );
    }
    return this.creationAnnounced;
  }

  private announceTransfer(transactions: IReadyTransaction[], transactionHttp: TransactionHttp): void {
    if (transactions.length === 1 ) {
      // sign and announce the transfer transaction
      const signedTransaction = transactions[0].initiator.account.sign(transactions[0].transaction);
      transactionHttp.announce(signedTransaction).subscribe(
        (x) => console.log(x),
        (err) => console.error(err));
    } else {
      // TODO: limit the aggregate to a 1000
      // we can use chunk from loadash

      // we extract unique initiators
      const initiators = uniqBy(transactions, 'initiator');
      const cosignatories: Account[] = [];
      for (let index = 1; index < initiators.length; index++) {
        // we create a cosignatory array excluding the first initioator
        cosignatories.push(initiators[index].initiator.account);
      }
      // we prepare the inner transaction for the aggregate transaction
      const innerTransactions: InnerTransaction[] = [];
      transactions.forEach((transaction) => {
        innerTransactions.push(transaction.transaction.toAggregate(
          transaction.initiator.account.publicAccount,
        ));
      });
      const aggregateTransaction = AggregateTransaction.createComplete(
        Deadline.create(),
        innerTransactions,
        NetworkType.MIJIN_TEST,
        [],
      );
      const signedTransaction = initiators[0].initiator.account.signTransactionWithCosignatories(
        aggregateTransaction,
        cosignatories);
      transactionHttp.announce(signedTransaction).subscribe(
        (x) => console.log(x),
        (err) => console.error(err));
    }
  }

}

export { Apostille };
