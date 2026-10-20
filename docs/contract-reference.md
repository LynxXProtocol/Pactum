https://stellar.expert/explorer/testnet/contract/CBADTVTJ6IN332HIKZ7LWUYMYTLPZYCEBV3X2HS47VHR5UDBHQ3GAA7E

## Commitment Templates

Templates make commitments machine-readable by constraining the structure
of the off-chain JSON document hashed into `terms_hash`.

### TemplateType Enum

| Variant            | Description                                                |
| ------------------ | ---------------------------------------------------------- |
| `Freeform`         | No schema constraint. Backward-compatible default.         |
| `RefundDeposit`    | Rental or payment deposit with a defined refund condition. |
| `SLAGuarantee`     | Service-level agreement with a measurable threshold.       |
| `MilestoneCheckIn` | Project milestone with a completion description.           |

### Off-Chain JSON Schemas

**RefundDeposit**

```json
{
  "template": "RefundDeposit",
  "refund_amount": "<number>",
  "currency": "<string>",
  "refund_condition": "<string description>"
}
```

**SLAGuarantee**

```json
{
  "template": "SLAGuarantee",
  "sla_threshold_percent": "<number 0-100>",
  "metric": "<uptime|latency|error_rate>",
  "measurement_window_days": "<number>"
}
```

**MilestoneCheckIn**

```json
{
  "template": "MilestoneCheckIn",
  "milestone_description": "<string>",
  "deliverable_url": "<optional string>"
}
```

The SHA-256 hash of the canonical JSON (keys sorted, no extra whitespace)
must equal the `terms_hash` field stored on-chain.
