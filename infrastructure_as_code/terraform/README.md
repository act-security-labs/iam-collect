# iam-collect Terraform Modules

This folder contains Terraform modules used to deploy iam-collect at scale across any number of AWS accounts, regions, and organizations. iam-collect seamlessly handles multiple organizations and accounts.

This will allow you to deploy an S3 bucket and a Step Functions state machine to scan all of your accounts and create either:

- a single folder containing all IAM information. This can be used immediately with [iam-lens](https://github.com/act-security-labs/iam-lens).
- a single SQLite database file containing all IAM information. This can be downloaded then queried directly or used with [iam-lens](https://github.com/act-security-labs/iam-lens).

## Notice

These modules are designed to be copied into your source control and customized according to your needs. They should not be referenced as remote modules. Please make sure you understand what you're doing when using third-party Terraform modules.

## Prerequisites

- Terraform 1.13+
- Node.js 22+

## Modules

### [list-accounts-role](./list-accounts-role/README.md)

This module creates a role that allows listing all accounts in the organization. This role is assumed by the List Accounts Lambda in the step function. If you already have a role that allows listing accounts, you can skip this module. If you are using multiple organizations, you will need to create a separate role in each organization.

### [collect-role](./collect-role/README.md)

`iam-collect` lists resources in your account such as roles, users, and policies. To do this, it needs a role in every account it scans. This module creates that role with the necessary permissions. You can use this module in any existing process you have to deploy to all of your accounts. If you already have a role you can leverage in the target accounts, you can skip this module.

### [collect-bucket](./collect-bucket/README.md)

This module creates an S3 bucket to store the collected IAM data. This is a generic module that creates an S3 bucket with Block Public Access enabled and SSE-S3 encryption. This is where all the collected IAM data will be stored.

### [collect-step-function](./collect-step-function/README.md)

This module creates a step function that will orchestrate the collection of IAM data across all accounts. It includes four lambda functions that are executed to populate the S3 bucket with IAM data.

1. Date Prefix Lambda - Creates a date prefix for the S3 bucket; defaults to the current date (e.g., `2024-01-01/`)
2. List Accounts Lambda - Lists all accounts in the organization(s) using the provided role(s)
3. Scan Account Lambda - Scans each account for IAM resources and writes the data to the S3 bucket. This is called in a parallel map for each account.
4. Index Data Lambda - After all accounts are scanned, this creates [the indexes](../../docs/Indexing.md) for easy lookup of resources.
