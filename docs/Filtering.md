# Filtering

You can customize what accounts, services, regions, and downloaded when you run `iam-collect download`. This can be done in the config file or by passing arguments to the command.

With an empty config file and no arguments, `iam-collect download` will download for the account linked to your default credentials. It will download information for all services in all regions.

**Effective Filter Logic**

> To determine the final set of accounts, services, and regions to scan, iam-collect will:
>
> 1. Start with any CLI-provided lists (via `--accounts`, `--services`, `--regions`). Any list not specified defaults to "all".
> 2. Narrow lists with the corresponding `included` lists in the config, if present.
> 3. Removing any items found in the corresponding `excluded` lists in the config, if present.
>
> CLI flags act as an upper bound, limiting the maximum scope regardless of config settings.

## Selecting Accounts

You can specify which AWS accounts iam-collect downloads by configuring the top-level `accounts.included` array in your config file:

```jsonc
{
  "accounts": {
    "included": ["123456789012", "210987654321"]
  }
}
```

Alternatively, override the config by passing a list to the CLI:

```bash
iam-collect download --accounts 123456789012 210987654321
```

If no accounts are specified on the CLI, or in the config, iam-collect will scan the account linked to your current (or [configured](Authentication.md)) credentials.

## Selecting Services

We tried to stay as closely to service codes as specified in the [SAR](https://docs.aws.amazon.com/service-authorization/latest/reference/reference_policies_actions-resources-contextkeys.html). A list of supported codes is in [services.ts](https://github.com/act-security-labs/iam-collect/blob/main/src/services.ts)

To limit which AWS services are scanned across all accounts and regions, use the top-level `services` block in your config:

```jsonc
{
  "services": {
    // Use either "included" or "excluded" to filter services
    "included": ["iam", "s3", "ec2"],
    "excluded": ["dynamodb"]
  }
}
```

You can also override at runtime:

```bash
iam-collect download --services iam s3 ec2
```

### Selecting Services By Account

For account‑specific service filters, add a `serviceConfigs` entry under `accountConfigs`:

```jsonc
{
  "accountConfigs": {
    "123456789012": {
      "services": {
        "included": ["iam", "s3"]
      }
    }
  }
}
```

This setting only affects that account; global `services` and CLI flags still apply to other accounts.

## Selecting Regions

iam-collect calls the [ListRegions](https://docs.aws.amazon.com/accounts/latest/reference/API_ListRegions.html) API to get a list of all enabled regions for each account scanned unless:

1. Regions are specified on the CLI via `--regions` or
2. A `regions.included` array is configured at the top level of the config file or
3. A `accountConfigs.<account_id>.regions.included` array is configured for the account

You can use your config file to specify which regions are scanned for all accounts and services via the top‑level `regions` block:

```jsonc
{
  "regions": {
    // Use either "included" or "excluded" to filter regions
    "included": ["us-east-1", "eu-west-1"],
    "excluded": ["us-west-2"]
  }
}
```

Or override at runtime:

```bash
iam-collect download --regions us-east-1 eu-west-1
```

### Selecting Regions By Account

To customize regions per account, add `regions` under that account in `accountConfigs`:

```jsonc
{
  "accountConfigs": {
    "123456789012": {
      "regions": {
        "included": ["us-east-1"],
        "excluded": ["eu-west-1"]
      }
    }
  }
}
```

### Selecting Regions By Account/Service

For the most granular control—regions for a specific service in a specific account—nest a `serviceConfigs` entry:

```jsonc
{
  "accountConfigs": {
    "123456789012": {
      "serviceConfigs": {
        "s3": {
          "regions": {
            "included": ["us-east-1"]
          }
        }
      }
    }
  }
}
```

## Combining Filters

You can combine account, service, and region filters in a single CLI invocation. For example:

```bash
iam-collect download \
  --accounts 123456789012 210987654321 \
  --services iam s3 ec2 \
  --regions us-east-1 eu-west-1 ap-southeast-2
```

This command will scan only the two specified accounts, limit the scan to IAM, S3, and EC2 resources, and restrict regions to us-east-1, eu-west-1, and ap-southeast-2. CLI flags act as an upper bound and may be further reduced by "included" and "excluded" lists in the config file.
