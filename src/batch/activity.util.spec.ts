import { analysisTransaction } from './activity.util';

/**
 * Fixture builders shaped like Mintlayer api-server /transaction/:txid
 * documents: amounts are decimal STRINGS on the wire (values may also be
 * numbers upstream), destinations are plain address strings.
 */
const OWN = 'tmt1ownaddress';
const OTHER = 'tmt1otheraddress';

const txOf = (inputs: any[], outputs: any[]) => ({
  id: 'txid-1',
  fee: { atoms: '1000', decimal: '0.00001' },
  timestamp: 1700000000,
  inputs,
  outputs,
});

const coinInput = (destination: string, decimal: string | number) => ({
  utxo: {
    destination,
    value: { type: 'Coin', amount: { atoms: '0', decimal } },
  },
});

const tokenInput = (
  destination: string,
  tokenId: string,
  decimal: string | number,
) => ({
  utxo: {
    destination,
    value: {
      type: 'TokenV1',
      token_id: tokenId,
      amount: { atoms: '0', decimal },
    },
  },
});

const coinOutput = (destination: string, decimal: string | number) => ({
  destination,
  value: { type: 'Coin', amount: { atoms: '0', decimal } },
});

const tokenOutput = (
  destination: string,
  tokenId: string,
  decimal: string | number,
) => ({
  destination,
  value: {
    type: 'TokenV1',
    token_id: tokenId,
    amount: { atoms: '0', decimal },
  },
});

describe('analysisTransaction', () => {
  it('copies txid, fee and timestamp into the activity envelope', () => {
    const tx = txOf([coinInput(OTHER, '5')], [coinOutput(OWN, '5')]);

    const activity = analysisTransaction({ tx, addresses: [OWN] });

    expect(activity.txid).toBe('txid-1');
    expect(activity.fee).toEqual({ atoms: '1000', decimal: '0.00001' });
    expect(activity.timestamp).toBe(1700000000);
  });

  describe('unsupported', () => {
    it('classifies an IssueNft input as unsupported', () => {
      const tx = txOf([{ utxo: { type: 'IssueNft' } }], [coinOutput(OWN, '1')]);

      const activity = analysisTransaction({ tx, addresses: [OWN] });

      expect(activity.type).toBe('unsupported');
      expect(activity.amount.inflow.total).toBe(0);
      expect(activity.amount.outflow.total).toBe(0);
    });

    it('classifies an IssueFungibleToken output as unsupported', () => {
      const tx = txOf(
        [coinInput(OTHER, '1')],
        [{ type: 'IssueFungibleToken', amount: { decimal: '10' } }],
      );

      const activity = analysisTransaction({ tx, addresses: [OWN] });

      expect(activity.type).toBe('unsupported');
    });
  });

  describe('delegation_withdrawal', () => {
    it('carries the delegation id and the first output amount as inflow', () => {
      const tx = txOf(
        [
          {
            input: {
              account_type: 'DelegationBalance',
              delegation_id: 'd0001',
            },
          },
        ],
        [coinOutput(OWN, '1.5'), coinOutput(OWN, '99')],
      );

      const activity = analysisTransaction({ tx, addresses: [OWN] });

      expect(activity.type).toBe('delegation_withdrawal');
      expect(activity.interact).toEqual({ delegation: 'd0001' });
      // Legacy wire format: the decimal string is carried verbatim.
      expect(activity.amount.inflow.total).toBe('1.5');
      expect(activity.amount.inflow.token).toEqual({ token_id: 'Coin' });
      expect(activity.amount.outflow.total).toBe(0);
    });
  });

  describe('delegation_staking', () => {
    it('carries the staked amount as outflow and the delegation id', () => {
      const tx = txOf(
        [coinInput(OWN, '100')],
        [
          {
            type: 'DelegateStaking',
            delegation_id: 'd0002',
            amount: { decimal: '100' },
          },
        ],
      );

      const activity = analysisTransaction({ tx, addresses: [OWN] });

      expect(activity.type).toBe('delegation_staking');
      expect(activity.interact).toEqual({ delegation: 'd0002' });
      expect(activity.amount.outflow.total).toBe('100');
      expect(activity.amount.outflow.token).toEqual({ token_id: 'Coin' });
      expect(activity.amount.inflow.total).toBe(0);
    });
  });

  describe('delegation_create', () => {
    it('classifies a CreateDelegationId output without amounts', () => {
      const tx = txOf([coinInput(OWN, '0')], [{ type: 'CreateDelegationId' }]);

      const activity = analysisTransaction({ tx, addresses: [OWN] });

      expect(activity.type).toBe('delegation_create');
      expect(activity.amount.inflow.total).toBe(0);
      expect(activity.amount.outflow.total).toBe(0);
    });
  });

  describe('swap', () => {
    it('nets spent-returned for the spent token and received for the other', () => {
      const tx = txOf(
        [
          {
            utxo: null,
            input: {
              command: 'FillOrder',
              destination: OWN,
              order_id: 'order-1',
            },
          },
          tokenInput(OWN, 'tok1', '10'),
        ],
        [
          tokenOutput(OWN, 'tok1', '2'),
          coinOutput(OWN, '5'),
          coinOutput(OTHER, '1'),
        ],
      );

      const activity = analysisTransaction({ tx, addresses: [OWN] });

      expect(activity.type).toBe('swap');
      expect(activity.interact).toEqual({ order_id: 'order-1' });
      expect(activity.amount.outflow).toEqual({
        total: 8,
        token: { token_id: 'tok1' },
      });
      expect(activity.amount.inflow).toEqual({
        total: 5,
        token: { token_id: 'Coin' },
      });
    });

    it('defaults the spent token to Coin for pure-coin fills', () => {
      const tx = txOf(
        [
          {
            utxo: null,
            input: {
              command: 'FillOrder',
              destination: OWN,
              order_id: 'order-2',
            },
          },
          coinInput(OWN, '10'),
        ],
        [coinOutput(OWN, '3')],
      );

      const activity = analysisTransaction({ tx, addresses: [OWN] });

      expect(activity.type).toBe('swap');
      expect(activity.amount.outflow).toEqual({
        total: 7,
        token: { token_id: 'Coin' },
      });
      // No output in a different token -> nothing received.
      expect(activity.amount.inflow).toEqual({
        total: 0,
        token: { token_id: 'Coin' },
      });
    });

    it('ignores FillOrder inputs whose destination is not ours', () => {
      const tx = txOf(
        [
          {
            utxo: null,
            input: {
              command: 'FillOrder',
              destination: OTHER,
              order_id: 'order-3',
            },
          },
          coinInput(OWN, '10'),
        ],
        [coinOutput(OWN, '10')],
      );

      const activity = analysisTransaction({ tx, addresses: [OWN] });

      expect(activity.type).toBe('send_self');
    });
  });

  describe('send_self', () => {
    it('reports equal in/out totals when only our addresses are involved', () => {
      const tx = txOf(
        [coinInput(OWN, '3'), coinInput(OWN, '4')],
        [coinOutput(OWN, '7')],
      );

      const activity = analysisTransaction({ tx, addresses: [OWN] });

      expect(activity.type).toBe('send_self');
      expect(activity.amount.outflow.total).toBe(7);
      expect(activity.amount.inflow.total).toBe(7);
      expect(activity.amount.outflow.token).toEqual({ token_id: 'Coin' });
      expect(activity.amount.inflow.token).toEqual({ token_id: 'Coin' });
    });

    it('tracks TokenV1 ids for self-transfers', () => {
      const tx = txOf(
        [tokenInput(OWN, 'tok9', '5')],
        [tokenOutput(OWN, 'tok9', '5')],
      );

      const activity = analysisTransaction({ tx, addresses: [OWN] });

      expect(activity.type).toBe('send_self');
      expect(activity.amount.outflow).toEqual({
        total: 5,
        token: { token_id: 'tok9' },
      });
      expect(activity.amount.inflow).toEqual({
        total: 5,
        token: { token_id: 'tok9' },
      });
    });
  });

  describe('send', () => {
    it('sums the other outputs and lists their destinations', () => {
      const tx = txOf(
        [coinInput(OWN, '10')],
        [coinOutput(OWN, '4'), coinOutput(OTHER, '6')],
      );

      const activity = analysisTransaction({ tx, addresses: [OWN] });

      expect(activity.type).toBe('send');
      expect(activity.amount.outflow.total).toBe(6);
      expect(activity.amount.outflow.token).toEqual({ token_id: 'Coin' });
      expect(activity.interact).toEqual({ addresses: [OTHER] });
    });

    it('uses the TokenV1 id of the sent token', () => {
      const tx = txOf(
        [tokenInput(OWN, 'tok7', '5')],
        [tokenOutput(OTHER, 'tok7', '5')],
      );

      const activity = analysisTransaction({ tx, addresses: [OWN] });

      expect(activity.type).toBe('send');
      expect(activity.amount.outflow).toEqual({
        total: 5,
        token: { token_id: 'tok7' },
      });
      expect(activity.interact).toEqual({ addresses: [OTHER] });
    });

    it('handles numeric decimal values (not only strings)', () => {
      const tx = txOf([coinInput(OWN, 10)], [coinOutput(OTHER, 6)]);

      const activity = analysisTransaction({ tx, addresses: [OWN] });

      expect(activity.type).toBe('send');
      expect(activity.amount.outflow.total).toBe(6);
    });
  });

  describe('receive', () => {
    it('sums our outputs and lists the input destinations', () => {
      const tx = txOf(
        [coinInput(OTHER, '9'), coinInput('tmt1secondsender', '1')],
        [coinOutput(OWN, '10')],
      );

      const activity = analysisTransaction({ tx, addresses: [OWN] });

      expect(activity.type).toBe('receive');
      expect(activity.amount.inflow.total).toBe(10);
      expect(activity.amount.inflow.token).toEqual({ token_id: 'Coin' });
      expect(activity.amount.outflow.total).toBe(0);
      expect(activity.interact).toEqual({
        addresses: [OTHER, 'tmt1secondsender'],
      });
    });

    it('tracks TokenV1 ids for received tokens', () => {
      const tx = txOf(
        [tokenInput(OTHER, 'tok5', '2.5')],
        [tokenOutput(OWN, 'tok5', '2.5')],
      );

      const activity = analysisTransaction({ tx, addresses: [OWN] });

      expect(activity.type).toBe('receive');
      expect(activity.amount.inflow).toEqual({
        total: 2.5,
        token: { token_id: 'tok5' },
      });
    });
  });

  describe('fallbacks', () => {
    it('returns the null-type envelope when nothing matches', () => {
      const tx = txOf(
        [coinInput(OTHER, '1')],
        [coinOutput('tmt1unrelated', '1')],
      );

      const activity = analysisTransaction({ tx, addresses: [OWN] });

      expect(activity.type).toBeNull();
      expect(activity.amount.inflow.total).toBe(0);
      expect(activity.amount.outflow.total).toBe(0);
    });
  });
});
