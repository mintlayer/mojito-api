/**
 * Faithful port of the legacy `analysisTransaction` classifier used by
 * POST /activity. Input tx shapes come verbatim from the Mintlayer
 * api-server `/transaction/:txid` documents; the quirks (including the
 * `unsupported` bucket and the swap in/out heuristics) are intentional —
 * the Mintini app consumes this exact taxonomy.
 */
export interface Activity {
  txid: unknown;
  type: string | null;
  timestamp: unknown;
  fee: unknown;
  interact?: Record<string, unknown>;
  // `total` carries the upstream decimal strings verbatim (legacy wire format).
  amount: {
    inflow: { total: any; token: { token_id: string } };
    outflow: { total: any; token: { token_id: string } };
  };
}

export function analysisTransaction({
  tx,
  addresses,
}: {
  tx: any;
  addresses: string[];
}): Activity {
  const { inputs, outputs } = tx;

  const activity: Activity = {
    txid: null,
    type: null,
    timestamp: null,
    fee: 0,
    amount: {
      inflow: {
        total: 0,
        token: { token_id: '' },
      },
      outflow: {
        total: 0,
        token: { token_id: '' },
      },
    },
  };

  activity.txid = tx.id;
  activity.fee = tx.fee;
  activity.timestamp = tx.timestamp;

  // filter out unsupported transactions
  const unsupportedTypes = [
    'IssueNft',
    'IssueFungibleToken',
    'CreateStakePool',
  ];

  const unsupportedInput = (inputs ?? []).filter((input: any) =>
    unsupportedTypes.includes(input?.utxo?.type),
  );
  const unsupportedOutput = (outputs ?? []).filter((output: any) =>
    unsupportedTypes.includes(output.type),
  );
  if (unsupportedInput.length > 0 || unsupportedOutput.length > 0) {
    activity.type = 'unsupported';
    return activity;
  }

  // check for delegation withdrawals
  const delegationWithdrawals = (inputs ?? []).filter(
    (input: any) => input?.input?.account_type === 'DelegationBalance',
  );
  if (delegationWithdrawals.length > 0) {
    activity.type = 'delegation_withdrawal';

    activity.interact = {
      delegation: inputs[0].input.delegation_id,
    };

    activity.amount.inflow.total = outputs[0].value.amount.decimal;
    activity.amount.inflow.token = { token_id: 'Coin' };

    return activity;
  }

  // check for delegation staking
  const delegationStaking = (outputs ?? []).filter(
    (output: any) => output?.type === 'DelegateStaking',
  );
  if (delegationStaking.length > 0) {
    activity.type = 'delegation_staking';

    activity.interact = {
      delegation: outputs[0].delegation_id,
    };

    activity.amount.outflow.total = (outputs ?? []).filter(
      (output: any) => output?.type === 'DelegateStaking',
    )[0].amount.decimal;
    activity.amount.outflow.token = { token_id: 'Coin' };

    return activity;
  }

  // check for delegation creation staking
  const delegationCreate = (outputs ?? []).filter(
    (output: any) => output?.type === 'CreateDelegationId',
  );
  if (delegationCreate.length > 0) {
    activity.type = 'delegation_create';
    return activity;
  }

  // lookup for utxo = null and input.command === 'FillOrder' in inputs
  const myFillOrders = (inputs ?? []).filter(
    (input: any) =>
      !input.utxo &&
      input.input?.command === 'FillOrder' &&
      addresses.includes(input.input.destination),
  );

  if (myFillOrders.length > 0) {
    const myInputs = (inputs ?? []).filter(
      (input: any) => input.utxo && addresses.includes(input.utxo.destination),
    );
    const myOutputs = (outputs ?? []).filter((output: any) =>
      addresses.includes(output.destination),
    );

    if (myInputs.length > 0 && myOutputs.length > 0) {
      activity.type = 'swap';

      // get order id
      const order_id = myFillOrders[0].input.order_id;
      activity.interact = { order_id };

      const spentTokenId =
        myInputs.find((input: any) => input.utxo.value.type === 'TokenV1')?.utxo
          .value.token_id || 'Coin';

      const spentTotal = myInputs
        .filter(
          (input: any) =>
            (input.utxo.value.token_id || 'Coin') === spentTokenId,
        )
        .reduce(
          (acc: number, input: any) =>
            acc + Number(input.utxo.value.amount.decimal),
          0,
        );

      const returnedTotal = myOutputs
        .filter(
          (output: any) => (output.value.token_id || 'Coin') === spentTokenId,
        )
        .reduce(
          (acc: number, output: any) =>
            acc + Number(output.value.amount.decimal),
          0,
        );

      const netSpent = spentTotal - returnedTotal;
      activity.amount.outflow = {
        total: netSpent,
        token: { token_id: spentTokenId },
      };

      const receivedOutputs = myOutputs.filter(
        (output: any) => (output.value.token_id || 'Coin') !== spentTokenId,
      );

      const receivedTotal = receivedOutputs.reduce(
        (acc: number, output: any) => acc + Number(output.value.amount.decimal),
        0,
      );

      const receivedTokenId =
        receivedOutputs.find(() => true)?.value.token_id || 'Coin';

      activity.amount.inflow = {
        total: receivedTotal,
        token: { token_id: receivedTokenId },
      };

      return activity;
    }
  }

  // lookup my addresses in inputs and outputs. if so, that transaction is
  // sending to someone else
  const myInputs = (inputs ?? []).filter(
    (input: any) => input.utxo && addresses.includes(input.utxo.destination),
  );
  const myOutputs = (outputs ?? []).filter((output: any) =>
    addresses.includes(output.destination),
  );

  const otherInputs = (inputs ?? []).filter(
    (input: any) => input.utxo && !addresses.includes(input.utxo.destination),
  );
  const otherOutputs = (outputs ?? []).filter(
    (output: any) => !addresses.includes(output.destination),
  );

  if (myInputs.length > 0 && myOutputs.length >= 0) {
    if (otherInputs.length === 0 && otherOutputs.length === 0) {
      activity.type = 'send_self';
      let token = '';

      // let's calculate the amount
      const inputAmount = myInputs.reduce((acc: number, input: any) => {
        acc += Number(input.utxo.value.amount.decimal);
        token =
          input.utxo.value.type === 'TokenV1'
            ? input.utxo.value.token_id
            : 'Coin';
        return acc;
      }, 0);
      activity.amount.outflow.total = inputAmount;
      activity.amount.outflow.token = { token_id: token };

      const outputAmount = myOutputs.reduce((acc: number, output: any) => {
        acc += Number(output.value.amount.decimal);
        token =
          output.value.type === 'TokenV1' ? output.value.token_id : 'Coin';
        return acc;
      }, 0);
      activity.amount.inflow.total = outputAmount;
      activity.amount.inflow.token = { token_id: token };

      return activity;
    }
  }

  if (myInputs.length > 0 && myOutputs.length >= 0) {
    activity.type = 'send';
    let token = '';

    // Legacy port note: the input side was computed but never used by the
    // original (`send` reports only the outbound amount) — kept as `_`.
    const _inputAmount = myInputs.reduce((acc: number, input: any) => {
      acc += Number(input.utxo.value.amount.decimal);
      token =
        input.utxo.value.type === 'TokenV1'
          ? input.utxo.value.token_id
          : 'Coin';
      return acc;
    }, 0);

    // let's calculate the amount send to other
    const outputAmount = otherOutputs.reduce((acc: number, output: any) => {
      acc += Number(output.value.amount.decimal);
      token = output.value.type === 'TokenV1' ? output.value.token_id : 'Coin';
      return acc;
    }, 0);

    const outputAddresses = otherOutputs.map(
      (output: any) => output.destination,
    );

    activity.amount.outflow.total = outputAmount;
    activity.amount.outflow.token = { token_id: token };
    activity.interact = { addresses: outputAddresses };
    return activity;
  }

  if (myInputs.length === 0 && myOutputs.length > 0) {
    activity.type = 'receive';
    let token = '';

    // let's calculate the amount
    const outputAmount = myOutputs.reduce((acc: number, output: any) => {
      acc += Number(output.value.amount.decimal);
      token = output.value.type === 'TokenV1' ? output.value.token_id : 'Coin';
      return acc;
    }, 0);

    const inputAddresses = (inputs ?? []).map(
      (input: any) => input.utxo.destination,
    );

    activity.amount.inflow.total = outputAmount;
    activity.amount.inflow.token = { token_id: token };
    activity.interact = { addresses: inputAddresses };
    return activity;
  }

  return activity;
}
