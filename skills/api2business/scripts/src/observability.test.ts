import {expect,test} from 'bun:test';
import {compactObservation} from './observability';

test('cost projection exposes stable wallet and account record arrays',()=>{
  const wallets=Array.from({length:12},(_,index)=>({walletKey:`https://wallet-${index}.example`}));
  const accounts=Array.from({length:11},(_,index)=>({accountId:index}));
  const compact=compactObservation({wallets,cost:{accounts}},false);
  expect(compact.walletRecords).toHaveLength(10);
  expect(compact.walletSummary).toEqual({total:12,omitted:2});
  expect(compact.cost.accountRecords).toHaveLength(10);
  expect(compact.cost.accountSummary).toEqual({total:11,omitted:1});

  const full=compactObservation({wallets,cost:{accounts}},true);
  expect(full.walletRecords).toHaveLength(12);
  expect(full.walletSummary).toEqual({total:12,omitted:0});
  expect(full.cost.accountRecords).toHaveLength(11);
});

test('cost projection accepts already bounded wallet and account arrays',()=>{
  const compact=compactObservation({wallets:{records:[{walletKey:'https://wallet.example'}],total:3,omitted:2},cost:{accounts:{records:[{accountId:1}],total:2,omitted:1}}},false);
  expect(compact.walletRecords).toEqual([{walletKey:'https://wallet.example'}]);
  expect(compact.walletSummary).toEqual({total:1,omitted:0});
  expect(compact.cost.accountRecords).toEqual([{accountId:1}]);
});
