# Storage

## Configuring Storage

iam-collect supports two storage backends: local file storage and S3-compatible storage. You can configure the storage backend in your config file in the `storage` section object with the `type` property. Valid values are `file` or `s3`.

### Configuring File Storage

You can configure the file storage backend by specifying the `type` as `file` and providing a `path` where the data will be stored. The path can be relative to the config file or an absolute path.

```jsonc
  "storage": {
    "type": "file",
    //If this starts with a '.', it is relative to the path iam-collected is executed in, otherwise it is an absolute path.
    "path": "./iam-data"
  }
```

### Configuring S3 Storage

Configure S3 storage by specifying the `type` as `s3` and providing the bucket name. You can also specify the region, an s3 endpoint, and a prefix.

By default the S3 storage will use the default configured credentials (or your default credential chain if none is configured). If you want to customize this you can specify an `auth` block, this will have the standard fields of a root `auth` block as described in the [Authentication](./Authentication.md) documentation.

#### Example S3 Storage Configuration with Default Credentials

```jsonc
  "storage": {
    // This is how you specify the storage type
    "type": "s3",
    //The name of your bucket
    "bucket": "my-bucket",

    //An optional prefix
    "prefix": "iam-data/",

    //If necessary, specify the region
    "region": "us-west-2",

    // Optional endpoint if using a specific VPC endpoint
    "endpoint": "https://s3.us-west-2.amazonaws.com",
  },
```

#### Example S3 Storage Configuration with Custom Credentials

```jsonc
  "storage": {
    // This is how you specify the storage type
    "type": "s3",

    //The name of your bucket
    "bucket": "my-bucket",

    //An optional prefix
    "prefix": "iam-data/",

    //If necessary, specify the region
    "region": "us-west-2",

    // Optional endpoint if using a specific VPC endpoint
    "endpoint": "https://s3.us-west-2.amazonaws.com",

    //Auth configuration, see https://github.com/act-security-labs/iam-collect/docs/Authentication.md
    "auth": {
      // Optional, if you have a specific profile configured that you would like to use.
      "profile": "my-profile",

      // Optional if you want to assume a role, if profile and role are both present, the profile will be used to assume the role. If a role is not specified, the default credentials will be used from the environment or the profile specified.
      "initialRole": {
        // **Specify either `arn` or `pathAndName`, NOT both.**
        // Use ARN to jump to a role in any account
        "arn": "arn:aws:iam::123456789012:role/iam-collect-role",
        // Use pathAndName if to go to assume a role in the same account as your profile or default credentials.
        "pathAndName": "IAMCollect",

        // Optional, the session name to use when assuming the role.
        "sessionName": "session-name",

        // Optional, external id to use if the role requires it.
        "externalId": "external-id"
      }
    }
  },
```

## Storage Layout Explained

The layout of the storage is designed to be usable by someone familiar with AWS resource ARNs and scale to any number of accounts, organization, and resources.

```text
aws/                                          # always `aws` for now, may add other clouds later
└── <partition>/                              # aws | aws-cn | aws-us-gov
    ├── accounts/
    │   └── <account-id>/                     # 12-digit AWS account ID
    │       ├── <service-name>/               # e.g., iam, s3, ec2
    │       │   └── <region>/                 # e.g., us-east-1 if applicable
    │       │       └── <resource-type>/      # e.g., user, policy, table, if applicable, omitted for s3 buckets
    │       │           └── <resource-id>/    # resource identifier
    │       │               ├── metadata.json # Data about the resource
    │       │               └── policy.json   # resource policy, or other data about the resource
    │       └── ram/                          # resources owned by the account shared via RAM
    │           └── <resourceArn>.json        # The RAM share metadata and resource policy
    ├── organizations/
    │   └── <organization-id>/                # AWS Organization ID
    │       ├── ous/                          # organizational units metadata
    │       ├── rcps/                         # resource control policies
    │       ├── s3-policies/                  # S3 policies
    │       ├── scps/                         # service control policies
    │       └── ....json                      # different metadata about the org such as accounts, or structure
    └── indexes/                              # search indexes for fast lookups
        ├── buckets-to-accounts.json
        ├── accounts-to-orgs.json
        └── ...                               # other index files
```

- **Accounts**: Under `accounts/`, each account directory contains:
  - **Resource folders**: Nested by `<service-name>/<region>/<resource-type>/<resource-id>/`, each holding `metadata.json` and `data.json`.
  - **RAM**: A `ram/` folder with JSON files (`<resourceArn>.json`) for Resource Access Manager shares.

- **Organizations**: Under `organizations/`, each org directory includes `accounts.json` (listing account IDs) and subfolders for `ous/`, `rcps/`, `s3-policies/`, and `scps/` containing respective metadata.

- **Indexes**: The `indexes/` folder contains JSON files that serve as search indexes for faster lookups, such as mapping buckets to accounts or accounts to organizations.

- **Partitions**: The top-level partition directories correspond to AWS partitions like `aws`, `aws-cn`, or `aws-us-gov`.
