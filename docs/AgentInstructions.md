# AI Agent Instructions for iam-collect Data Analysis

This document provides comprehensive instructions for AI systems to understand, navigate, and analyze data collected by iam-collect. The data is structured in a hierarchical filesystem layout that mirrors AWS resource organization and enables powerful IAM policy analysis.

## Overview

iam-collect stores AWS IAM-related data in a structured filesystem format optimized for analysis and programmatic access. The data includes:

- AWS resource metadata and policies
- IAM roles, policies, and trust relationships
- AWS Organizations structure and policies
- Cross-account resource sharing (RAM)
- Search indexes for efficient lookups

## Filesystem Structure

### Root Structure

```
<storage-path>/
└── aws/                          # Always 'aws' (may support other clouds later)
    └── <partition>/              # AWS partition: 'aws', 'aws-cn', or 'aws-us-gov'
        ├── accounts/             # Account-specific resources
        ├── organizations/        # AWS Organizations data
        └── indexes/             # Pre-built search indexes
```

### Account Resources Structure

```
accounts/
└── <account-id>/                 # 12-digit AWS account ID (e.g., 193045323908)
    ├── <service>/               # AWS service name (iam, s3, ec2, etc.)
    │   └── [<region>/]          # Region (for regional services)
    │       └── [<resource-type>/] # Resource type (role, policy, bucket, etc.)
    │           └── <resource-id>/  # URL-encoded resource identifier
    │               ├── metadata.json    # Resource metadata
    │               ├── policy.json      # Resource-based policy (if exists)
    │               ├── trust-policy.json # Trust policy (for IAM roles)
    │               ├── inline-policies.json # Inline policies
    │               └── <other>.json     # Other resource-specific data
    ├── ram/                     # Resource Access Manager shares
    │   └── <region>/            # Region or 'global'
    │       └── <encoded-arn>.json # RAM resource data
    └── organization.json        # Organization membership info
```

### Organizations Structure

```
organizations/
└── <organization-id>/           # AWS Organization ID (e.g., o-uch56v3mmz)
    ├── metadata.json           # Organization metadata and features
    ├── accounts.json           # Account list and details
    ├── structure.json          # Organizational unit hierarchy
    ├── delegated-admins.json   # Service principal → account ID mappings
    ├── ous/                    # Organizational Units
    │   └── <ou-id>/
    │       ├── metadata.json   # OU metadata
    │       └── tags.json       # OU tags
    ├── scps/                   # Service Control Policies
    │   └── <policy-id>/
    │       ├── metadata.json   # Policy metadata
    │       ├── policy.json     # Policy document
    │       └── tags.json       # Policy tags
    └── rcps/                   # Resource Control Policies (similar to SCPs)
```

### Indexes Structure

```
indexes/
├── accounts-to-orgs.json           # Account ID → Organization ID mapping
├── buckets-to-accounts.json        # S3 bucket → Account mapping
├── principals-to-trust-policies.json # Principal → Roles that trust them
├── apigateways-to-accounts.json     # API Gateway → Account mapping
└── vpcs.json                       # VPC information across accounts
```

## File Naming Conventions

### ARN to Filesystem Path Conversion

AWS ARNs are converted to filesystem paths using these rules:

1. **ARN Format**: `arn:partition:service:region:account-id:resource-type/resource-id`
2. **Path Format**: `accounts/<account-id>/<service>/[<region>/][<resource-type>/]<encoded-resource-id>/`

### Encoding Rules

- **Resource IDs**: URL-encoded (e.g., `aws-service-role/sso.amazonaws.com/AWSServiceRoleForSSO` → `aws-service-role%2fsso.amazonaws.com%2fawsserviceroleforSSO`)
- **All paths**: Converted to lowercase
- **Special characters**: Colons (`:`) and slashes (`/`) in ARNs become hyphens (`-`) in RAM filenames

### Examples

| ARN                                                | Filesystem Path                                      |
| -------------------------------------------------- | ---------------------------------------------------- |
| `arn:aws:iam::123456789012:role/MyRole`            | `accounts/123456789012/iam/role/myrole/`             |
| `arn:aws:s3:::my-bucket`                           | `accounts/123456789012/s3/my-bucket/`                |
| `arn:aws:iam::aws:policy/AdminAccess`              | `accounts/123456789012/iam/aws/policy/adminaccess/`  |
| `arn:aws:ec2:us-east-1:123456789012:vpc/vpc-12345` | `accounts/123456789012/ec2/us-east-1/vpc/vpc-12345/` |

## Data File Types

### Resource Files

- **`metadata.json`**: Core resource metadata (ARN, name, creation date, etc.)
- **`policy.json`**: Resource-based policies (S3 bucket policies, resource policies)
- **`trust-policy.json`**: IAM role trust policies
- **`inline-policies.json`**: IAM entity inline policies
- **`tags.json`**: Resource tags
- **`encryption.json`**: Encryption configuration
- **`bpa.json`**: Block Public Access settings (S3)

Identity Store directory resources use their AWS Identity Store ARNs and are stored under
`accounts/<account-id>/identitystore/`:

- **Users** (`user/<user-id>/`): `metadata.json` contains profile attributes and `groups.json`
  contains the Identity Store group ARNs for the user.
- **Groups** (`group/<group-id>/`): `metadata.json` contains group attributes and `members.json`
  contains the Identity Store user ARNs in the group.
- **Memberships** (`membership/<membership-id>/`): `metadata.json` contains `groupArn` and
  `memberArn` relationship endpoints, plus the source Identity Store and IAM Identity Center
  instance identifiers.

### Organization Files

- **`metadata.json`**: Organization details, root OU, features enabled
- **`accounts.json`**: All accounts with OU mappings and policy assignments
- **`structure.json`**: Complete OU hierarchy
- **`delegated-admins.json`**: Service principal to account mappings

## Common Analysis Patterns

### 1. Finding Roles with Overly Permissive Trust Policies

**Goal**: Find roles that trust all principals (`"*"`)

**Approach**:

```python
# Pseudo-code for finding overly permissive trust policies
def find_overly_permissive_roles(base_path):
    overly_permissive = []

    for account_dir in glob(f"{base_path}/accounts/*/"):
        trust_policies = glob(f"{account_dir}/iam/role/*/trust-policy.json")

        for policy_file in trust_policies:
            policy = json.load(open(policy_file))
            role_path = os.path.dirname(policy_file)

            for statement in policy.get("Statement", []):
                principal = statement.get("Principal", {})

                # Check for wildcard principals
                if principal == "*" or \
                   (isinstance(principal, dict) and "*" in str(principal)):
                    metadata = json.load(open(f"{role_path}/metadata.json"))
                    overly_permissive.append({
                        "arn": metadata["arn"],
                        "account": extract_account_from_path(role_path),
                        "trust_policy": policy
                    })

    return overly_permissive
```

**Bash/Shell Alternative**:

```bash
#!/bin/bash

# Find roles with overly permissive trust policies
find_overly_permissive_roles() {
    local base_path="$1"
    local output_file="${2:-overly_permissive_roles.json}"

    echo "Finding roles with overly permissive trust policies..."
    echo "[]" > "$output_file"

    find "$base_path/accounts" -name "trust-policy.json" -type f | while read -r policy_file; do
        role_dir=$(dirname "$policy_file")

        # Check if trust policy contains wildcard principals
        if jq -e '.Statement[]? | select(.Principal == "*" or (.Principal | type == "object" and (. | tostring | contains("*"))))' "$policy_file" >/dev/null 2>&1; then
            # Extract role metadata
            if [[ -f "$role_dir/metadata.json" ]]; then
                role_arn=$(jq -r '.arn' "$role_dir/metadata.json")
                account_id=$(echo "$role_dir" | grep -o '/accounts/[^/]*' | cut -d'/' -f3)

                echo "Found overly permissive role: $role_arn in account $account_id"

                # Add to results (using temporary file for atomic updates)
                temp_file=$(mktemp)
                jq --arg arn "$role_arn" --arg account "$account_id" --slurpfile trust_policy "$policy_file" \
                   '. + [{"arn": $arn, "account": $account, "trust_policy": $trust_policy[0]}]' \
                   "$output_file" > "$temp_file" && mv "$temp_file" "$output_file"
            fi
        fi
    done

    echo "Results saved to $output_file"
}

# Usage: find_overly_permissive_roles "/path/to/iam-data" "results.json"
```

### 2. Finding Policies with Wildcard Resource Access

**Goal**: Find policies granting access to all resources (`"Resource": "*"`)

**Approach**:

```python
# Check both inline policies and managed policies
def find_wildcard_resource_policies(base_path):
    wildcard_policies = []

    # Check inline policies
    for policy_file in glob(f"{base_path}/accounts/*/iam/*/inline-policies.json"):
        policies = json.load(open(policy_file))
        check_policy_statements(policies, policy_file, wildcard_policies)

    # Check managed policies
    for policy_file in glob(f"{base_path}/accounts/*/iam/policy/*/policy.json"):
        policy = json.load(open(policy_file))
        check_policy_statements({"policies": [policy]}, policy_file, wildcard_policies)

    # Check resource-based policies
    for policy_file in glob(f"{base_path}/accounts/*/*/policy.json"):
        policy = json.load(open(policy_file))
        check_policy_statements({"policies": [policy]}, policy_file, wildcard_policies)

    return wildcard_policies

def check_policy_statements(policy_container, file_path, results):
    for policy in policy_container.get("policies", []):
        for statement in policy.get("Statement", []):
            resources = statement.get("Resource", [])
            if isinstance(resources, str):
                resources = [resources]

            if "*" in resources:
                results.append({
                    "file": file_path,
                    "policy": policy,
                    "wildcard_statement": statement
                })
```

**Bash/Shell Alternative**:

```bash
#!/bin/bash

# Find policies with wildcard resource access
find_wildcard_resource_policies() {
    local base_path="$1"
    local output_file="${2:-wildcard_policies.json}"

    echo "Finding policies with wildcard resource access..."
    echo "[]" > "$output_file"

    # Function to check policy statements for wildcard resources
    check_policy_for_wildcards() {
        local policy_file="$1"
        local policy_type="$2"

        # Check if policy contains statements with "Resource": "*"
        if jq -e '.Statement[]? | select(.Resource == "*" or (.Resource | type == "array" and . | contains(["*"])))' "$policy_file" >/dev/null 2>&1; then
            echo "Found wildcard policy: $policy_file ($policy_type)"

            # Extract wildcard statements
            wildcard_statements=$(jq '[.Statement[]? | select(.Resource == "*" or (.Resource | type == "array" and . | contains(["*"])))]' "$policy_file")

            # Add to results
            temp_file=$(mktemp)
            jq --arg file "$policy_file" --arg type "$policy_type" --argjson statements "$wildcard_statements" \
               '. + [{"file": $file, "policy_type": $type, "wildcard_statements": $statements}]' \
               "$output_file" > "$temp_file" && mv "$temp_file" "$output_file"
        fi
    }

    # Check inline policies
    echo "Checking inline policies..."
    find "$base_path/accounts" -name "inline-policies.json" -type f | while read -r policy_file; do
        # Check each policy in the inline policies file
        jq -r '.policies[]? | @base64' "$policy_file" 2>/dev/null | while read -r encoded_policy; do
            if [[ -n "$encoded_policy" ]]; then
                decoded_policy=$(echo "$encoded_policy" | base64 -d)
                echo "$decoded_policy" | jq -e '.Statement[]? | select(.Resource == "*" or (.Resource | type == "array" and . | contains(["*"])))' >/dev/null 2>&1
                if [[ $? -eq 0 ]]; then
                    check_policy_for_wildcards "$policy_file" "inline"
                    break
                fi
            fi
        done
    done

    # Check managed policies
    echo "Checking managed policies..."
    find "$base_path/accounts" -path "*/iam/policy/*/policy.json" -type f | while read -r policy_file; do
        check_policy_for_wildcards "$policy_file" "managed"
    done

    # Check resource-based policies (S3, Lambda, etc.)
    echo "Checking resource-based policies..."
    find "$base_path/accounts" -name "policy.json" -type f | grep -v "/iam/policy/" | while read -r policy_file; do
        check_policy_for_wildcards "$policy_file" "resource-based"
    done

    echo "Results saved to $output_file"
}

# Usage: find_wildcard_resource_policies "/path/to/iam-data" "wildcard_results.json"
```

### 3. Cross-Account Access Analysis

**Goal**: Find resources accessible from other accounts

**Method 1 - Use the trust policy index**:

```python
# Load the pre-built index
principals_index = json.load(open(f"{base_path}/indexes/principals-to-trust-policies.json"))

def find_cross_account_access(base_path, target_account):
    cross_account_access = []

    for account_id, principals in principals_index.items():
        if account_id == target_account:
            continue

        for principal_type, principal_data in principals.items():
            for principal, trusted_roles in principal_data.items():
                # Check if principal is from target account
                if target_account in principal:
                    cross_account_access.append({
                        "trusting_account": account_id,
                        "trusted_principal": principal,
                        "roles": trusted_roles
                    })

    return cross_account_access
```

**Method 2 - Direct filesystem scan**:

```python
def find_cross_account_trusts(base_path, target_account):
    cross_account_trusts = []

    for trust_policy_file in glob(f"{base_path}/accounts/*/iam/role/*/trust-policy.json"):
        policy = json.load(open(trust_policy_file))
        role_path = os.path.dirname(trust_policy_file)

        for statement in policy.get("Statement", []):
            principal = statement.get("Principal", {})

            # Extract account from principal ARNs
            if isinstance(principal, dict):
                for principal_type, principal_values in principal.items():
                    if isinstance(principal_values, list):
                        for value in principal_values:
                            if target_account in str(value):
                                cross_account_trusts.append({
                                    "role_path": role_path,
                                    "trusted_principal": value,
                                    "statement": statement
                                })

    return cross_account_trusts
```

**Bash/Shell Alternative**:

```bash
#!/bin/bash

# Cross-account access analysis using pre-built index
find_cross_account_access_indexed() {
    local base_path="$1"
    local target_account="$2"
    local output_file="${3:-cross_account_access.json}"

    echo "Analyzing cross-account access for account: $target_account"
    echo "[]" > "$output_file"

    local index_file="$base_path/indexes/principals-to-trust-policies.json"

    if [[ ! -f "$index_file" ]]; then
        echo "Error: Principals index not found at $index_file"
        return 1
    fi

    # Use jq to find cross-account access from the index
    jq -r --arg target "$target_account" '
        to_entries[] |
        select(.key != $target) as $account |
        $account.value | to_entries[] as $principal_type |
        $principal_type.value | to_entries[] as $principal |
        select($principal.key | contains($target)) |
        {
            "trusting_account": $account.key,
            "trusted_principal": $principal.key,
            "roles": $principal.value
        }
    ' "$index_file" > "$output_file"

    echo "Cross-account access analysis saved to $output_file"
}

# Direct filesystem scan for cross-account trusts
find_cross_account_trusts() {
    local base_path="$1"
    local target_account="$2"
    local output_file="${3:-cross_account_trusts.json}"

    echo "Scanning trust policies for cross-account access to: $target_account"
    echo "[]" > "$output_file"

    find "$base_path/accounts" -name "trust-policy.json" -type f | while read -r trust_policy_file; do
        role_dir=$(dirname "$trust_policy_file")

        # Check if trust policy references the target account
        if jq -e --arg target "$target_account" '
            .Statement[]? |
            .Principal |
            if type == "object" then
                [.. | strings] | map(select(contains($target))) | length > 0
            else
                contains($target)
            end
        ' "$trust_policy_file" >/dev/null 2>&1; then

            echo "Found cross-account trust: $trust_policy_file"

            # Extract the trusting role ARN
            if [[ -f "$role_dir/metadata.json" ]]; then
                role_arn=$(jq -r '.arn' "$role_dir/metadata.json")
                trusting_account=$(echo "$role_arn" | cut -d':' -f5)

                # Extract matching principals and statements
                trusted_principals=$(jq -r --arg target "$target_account" '
                    [.Statement[]? |
                     .Principal |
                     if type == "object" then
                         [.. | strings] | map(select(contains($target)))
                     else
                         select(contains($target))
                     end] |
                    flatten | unique
                ' "$trust_policy_file")

                # Add to results
                temp_file=$(mktemp)
                jq --arg role_path "$role_dir" \
                   --arg role_arn "$role_arn" \
                   --arg trusting_account "$trusting_account" \
                   --argjson principals "$trusted_principals" \
                   '. + [{
                       "role_path": $role_path,
                       "role_arn": $role_arn,
                       "trusting_account": $trusting_account,
                       "trusted_principals": $principals
                   }]' \
                   "$output_file" > "$temp_file" && mv "$temp_file" "$output_file"
            fi
        fi
    done

    echo "Cross-account trust analysis saved to $output_file"
}

# Usage:
# find_cross_account_access_indexed "/path/to/iam-data" "123456789012" "results.json"
# find_cross_account_trusts "/path/to/iam-data" "123456789012" "trusts.json"
```

### 4. Organization Policy Analysis

**Goal**: Analyze Service Control Policies and delegation

**Approach**:

```python
def analyze_organization_policies(base_path, org_id):
    org_path = f"{base_path}/organizations/{org_id}"

    # Load organization structure
    metadata = json.load(open(f"{org_path}/metadata.json"))
    accounts = json.load(open(f"{org_path}/accounts.json"))
    structure = json.load(open(f"{org_path}/structure.json"))
    delegated_admins = json.load(open(f"{org_path}/delegated-admins.json"))

    # Analyze SCPs
    scps = []
    for scp_dir in glob(f"{org_path}/scps/*/"):
        scp_metadata = json.load(open(f"{scp_dir}/metadata.json"))
        scp_policy = json.load(open(f"{scp_dir}/policy.json"))
        scps.append({
            "metadata": scp_metadata,
            "policy": scp_policy
        })

    return {
        "organization": metadata,
        "accounts": accounts,
        "structure": structure,
        "delegated_administrators": delegated_admins,
        "service_control_policies": scps
    }
```

**Bash/Shell Alternative**:

```bash
#!/bin/bash

# Analyze organization policies and structure
analyze_organization_policies() {
    local base_path="$1"
    local org_id="$2"
    local output_file="${3:-organization_analysis.json}"

    local org_path="$base_path/organizations/$org_id"

    if [[ ! -d "$org_path" ]]; then
        echo "Error: Organization directory not found: $org_path"
        return 1
    fi

    echo "Analyzing organization: $org_id"

    # Initialize result structure
    echo '{"organization": null, "accounts": null, "structure": null, "delegated_administrators": null, "service_control_policies": []}' > "$output_file"

    # Load organization metadata
    if [[ -f "$org_path/metadata.json" ]]; then
        jq --slurpfile metadata "$org_path/metadata.json" '.organization = $metadata[0]' "$output_file" > temp.json && mv temp.json "$output_file"
    fi

    # Load accounts information
    if [[ -f "$org_path/accounts.json" ]]; then
        jq --slurpfile accounts "$org_path/accounts.json" '.accounts = $accounts[0]' "$output_file" > temp.json && mv temp.json "$output_file"
    fi

    # Load organizational structure
    if [[ -f "$org_path/structure.json" ]]; then
        jq --slurpfile structure "$org_path/structure.json" '.structure = $structure[0]' "$output_file" > temp.json && mv temp.json "$output_file"
    fi

    # Load delegated administrators
    if [[ -f "$org_path/delegated-admins.json" ]]; then
        jq --slurpfile delegated "$org_path/delegated-admins.json" '.delegated_administrators = $delegated[0]' "$output_file" > temp.json && mv temp.json "$output_file"
    fi

    # Analyze Service Control Policies
    echo "Analyzing Service Control Policies..."
    if [[ -d "$org_path/scps" ]]; then
        for scp_dir in "$org_path/scps"/*/; do
            if [[ -d "$scp_dir" ]]; then
                scp_name=$(basename "$scp_dir")
                echo "Processing SCP: $scp_name"

                # Create SCP object
                scp_object='{"metadata": null, "policy": null}'

                # Add metadata if available
                if [[ -f "$scp_dir/metadata.json" ]]; then
                    scp_object=$(echo "$scp_object" | jq --slurpfile metadata "$scp_dir/metadata.json" '.metadata = $metadata[0]')
                fi

                # Add policy if available
                if [[ -f "$scp_dir/policy.json" ]]; then
                    scp_object=$(echo "$scp_object" | jq --slurpfile policy "$scp_dir/policy.json" '.policy = $policy[0]')
                fi

                # Add to results
                jq --argjson scp "$scp_object" '.service_control_policies += [$scp]' "$output_file" > temp.json && mv temp.json "$output_file"
            fi
        done
    fi

    echo "Organization analysis saved to $output_file"
}

# Generate organization summary report
generate_org_summary() {
    local analysis_file="$1"
    local summary_file="${2:-organization_summary.txt}"

    if [[ ! -f "$analysis_file" ]]; then
        echo "Error: Analysis file not found: $analysis_file"
        return 1
    fi

    echo "Organization Summary Report" > "$summary_file"
    echo "=========================" >> "$summary_file"
    echo "" >> "$summary_file"

    # Organization info
    jq -r '
        "Organization ID: " + (.organization.id // "N/A") + "\n" +
        "Master Account: " + (.organization.masterAccountId // "N/A") + "\n" +
        "Feature Set: " + (.organization.featureSet // "N/A") + "\n"
    ' "$analysis_file" >> "$summary_file"

    # Account count
    echo -n "Total Accounts: " >> "$summary_file"
    jq -r '.accounts | length' "$analysis_file" >> "$summary_file"

    # SCP count
    echo -n "Service Control Policies: " >> "$summary_file"
    jq -r '.service_control_policies | length' "$analysis_file" >> "$summary_file"

    # Delegated administrators
    echo "" >> "$summary_file"
    echo "Delegated Administrators:" >> "$summary_file"
    jq -r '.delegated_administrators | to_entries[] | "  " + .key + ": " + (.value | join(", "))' "$analysis_file" >> "$summary_file"

    echo "" >> "$summary_file"
    echo "Summary report saved to $summary_file"
}

# Usage:
# analyze_organization_policies "/path/to/iam-data" "o-example123456" "org_analysis.json"
# generate_org_summary "org_analysis.json" "summary.txt"
```

### 5. Resource Enumeration by Service

**Goal**: List all resources of a specific type

**Approach**:

```python
def list_resources_by_type(base_path, service, resource_type=None, region=None):
    resources = []

    # Build glob pattern
    pattern_parts = [base_path, "accounts", "*", service]
    if region:
        pattern_parts.append(region)
    if resource_type:
        pattern_parts.append(resource_type)
    pattern_parts.extend(["*", "metadata.json"])

    pattern = "/".join(pattern_parts)

    for metadata_file in glob(pattern):
        metadata = json.load(open(metadata_file))
        resource_dir = os.path.dirname(metadata_file)
        account_id = extract_account_from_path(metadata_file)

        # Check for associated policy files
        policy_files = glob(f"{resource_dir}/*.json")

        resources.append({
            "metadata": metadata,
            "account_id": account_id,
            "resource_directory": resource_dir,
            "available_data": [os.path.basename(f) for f in policy_files]
        })

    return resources

# Examples:
# list_resources_by_type(base_path, "s3")  # All S3 resources
# list_resources_by_type(base_path, "iam", "role")  # All IAM roles
# list_resources_by_type(base_path, "ec2", "vpc", "us-east-1")  # VPCs in us-east-1
```

**Bash/Shell Alternative**:

```bash
#!/bin/bash

# List all resources of a specific type
list_resources_by_type() {
    local base_path="$1"
    local service="$2"
    local resource_type="$3"
    local region="$4"
    local output_file="${5:-resources.json}"

    echo "Listing resources for service: $service"
    [[ -n "$resource_type" ]] && echo "Resource type: $resource_type"
    [[ -n "$region" ]] && echo "Region: $region"

    echo "[]" > "$output_file"

    # Build find pattern
    local pattern="$base_path/accounts/*/$service"
    [[ -n "$region" ]] && pattern="$pattern/$region"
    [[ -n "$resource_type" ]] && pattern="$pattern/$resource_type"
    pattern="$pattern/*/metadata.json"

    # Find all matching metadata files
    find $pattern -type f 2>/dev/null | while read -r metadata_file; do
        if [[ -f "$metadata_file" ]]; then
            resource_dir=$(dirname "$metadata_file")

            # Extract account ID from path
            account_id=$(echo "$metadata_file" | grep -o '/accounts/[^/]*' | cut -d'/' -f3)

            # Get list of available data files
            available_data=$(find "$resource_dir" -name "*.json" -exec basename {} \; | tr '\n' ',' | sed 's/,$//')

            # Create resource object
            resource_object=$(jq -n \
                --slurpfile metadata "$metadata_file" \
                --arg account_id "$account_id" \
                --arg resource_directory "$resource_dir" \
                --arg available_data "$available_data" \
                '{
                    "metadata": $metadata[0],
                    "account_id": $account_id,
                    "resource_directory": $resource_directory,
                    "available_data": ($available_data | split(",") | map(select(. != "")))
                }')

            # Add to results
            temp_file=$(mktemp)
            jq --argjson resource "$resource_object" '. + [$resource]' "$output_file" > "$temp_file" && mv "$temp_file" "$output_file"

            # Extract resource name/ARN for display
            resource_name=$(jq -r '.arn // .name // .id // "unknown"' "$metadata_file" 2>/dev/null)
            echo "Found: $resource_name in account $account_id"
        fi
    done

    # Display summary
    total_resources=$(jq length "$output_file")
    echo "Total resources found: $total_resources"
    echo "Results saved to $output_file"
}

# Quick resource counting function
count_resources_by_service() {
    local base_path="$1"
    local output_file="${2:-resource_counts.txt}"

    echo "Resource Counts by Service" > "$output_file"
    echo "=========================" >> "$output_file"
    echo "" >> "$output_file"

    # Count resources for each service
    for service_dir in "$base_path"/accounts/*/*/; do
        if [[ -d "$service_dir" ]]; then
            service=$(basename "$service_dir")
            # Skip iam as it has special structure
            if [[ "$service" != "iam" ]]; then
                count=$(find "$service_dir" -name "metadata.json" | wc -l)
                if [[ $count -gt 0 ]]; then
                    printf "%-20s: %d\n" "$service" "$count" >> "$output_file"
                fi
            fi
        fi
    done

    # Count IAM resources separately
    iam_roles=$(find "$base_path"/accounts/*/iam/role -name "metadata.json" 2>/dev/null | wc -l)
    iam_users=$(find "$base_path"/accounts/*/iam/user -name "metadata.json" 2>/dev/null | wc -l)
    iam_groups=$(find "$base_path"/accounts/*/iam/group -name "metadata.json" 2>/dev/null | wc -l)
    iam_policies=$(find "$base_path"/accounts/*/iam/policy -name "metadata.json" 2>/dev/null | wc -l)

    echo "" >> "$output_file"
    echo "IAM Resources:" >> "$output_file"
    printf "%-20s: %d\n" "roles" "$iam_roles" >> "$output_file"
    printf "%-20s: %d\n" "users" "$iam_users" >> "$output_file"
    printf "%-20s: %d\n" "groups" "$iam_groups" >> "$output_file"
    printf "%-20s: %d\n" "policies" "$iam_policies" >> "$output_file"

    echo "" >> "$output_file"
    echo "Resource count summary saved to $output_file"
}

# Generate resource inventory across all accounts
generate_resource_inventory() {
    local base_path="$1"
    local output_dir="${2:-inventory}"

    mkdir -p "$output_dir"

    echo "Generating comprehensive resource inventory..."

    # Generate service-specific inventories
    list_resources_by_type "$base_path" "s3" "" "" "$output_dir/s3_buckets.json"
    list_resources_by_type "$base_path" "ec2" "instance" "" "$output_dir/ec2_instances.json"
    list_resources_by_type "$base_path" "lambda" "function" "" "$output_dir/lambda_functions.json"
    list_resources_by_type "$base_path" "iam" "role" "" "$output_dir/iam_roles.json"
    list_resources_by_type "$base_path" "iam" "user" "" "$output_dir/iam_users.json"

    # Generate counts
    count_resources_by_service "$base_path" "$output_dir/resource_counts.txt"

    echo "Resource inventory generated in: $output_dir"
}

# Usage examples:
# list_resources_by_type "/path/to/iam-data" "s3" "" "" "s3_resources.json"
# list_resources_by_type "/path/to/iam-data" "iam" "role" "" "iam_roles.json"
# list_resources_by_type "/path/to/iam-data" "ec2" "vpc" "us-east-1" "vpc_resources.json"
# count_resources_by_service "/path/to/iam-data" "counts.txt"
# generate_resource_inventory "/path/to/iam-data" "my_inventory"
```

## Index Files for Efficient Queries

### Pre-built Indexes

The `indexes/` directory contains pre-computed mappings for common queries:

1. **`principals-to-trust-policies.json`**: Maps each principal to roles that trust it

   ```json
   {
     "account-id": {
       "principal": {
         "arn:aws:iam::account:user/username": ["role-arn1", "role-arn2"],
         "service.amazonaws.com": ["role-arn3"]
       }
     }
   }
   ```

2. **`accounts-to-orgs.json`**: Maps account IDs to organization IDs

   ```json
   {
     "123456789012": "o-example123456"
   }
   ```

3. **`buckets-to-accounts.json`**: Maps S3 bucket names to account IDs
   ```json
   {
     "my-bucket-name": "123456789012"
   }
   ```

### Using Indexes

```python
# Load and use indexes for fast lookups
def get_organization_for_account(base_path, account_id):
    accounts_index = json.load(open(f"{base_path}/indexes/accounts-to-orgs.json"))
    return accounts_index.get(account_id)

def get_roles_trusting_principal(base_path, principal_arn):
    trust_index = json.load(open(f"{base_path}/indexes/principals-to-trust-policies.json"))

    for account_id, principals in trust_index.items():
        for principal_type, principal_data in principals.items():
            if principal_arn in principal_data:
                return principal_data[principal_arn]

    return []
```

**Bash/Shell Alternative for Index Operations**:

```bash
#!/bin/bash

# Get organization for account using index
get_organization_for_account() {
    local base_path="$1"
    local account_id="$2"
    local index_file="$base_path/indexes/accounts-to-orgs.json"

    if [[ -f "$index_file" ]]; then
        jq -r --arg account "$account_id" '.[$account] // "not_found"' "$index_file"
    else
        echo "index_not_found"
    fi
}

# Get roles trusting a specific principal
get_roles_trusting_principal() {
    local base_path="$1"
    local principal_arn="$2"
    local index_file="$base_path/indexes/principals-to-trust-policies.json"

    if [[ -f "$index_file" ]]; then
        jq -r --arg principal "$principal_arn" '
            [.[] | to_entries[] | .value | to_entries[] | select(.key == $principal) | .value] |
            flatten |
            unique |
            if length > 0 then .[] else empty end
        ' "$index_file"
    else
        echo "Error: Index file not found: $index_file" >&2
        return 1
    fi
}

# Find which account owns a specific S3 bucket
get_account_for_bucket() {
    local base_path="$1"
    local bucket_name="$2"
    local index_file="$base_path/indexes/buckets-to-accounts.json"

    if [[ -f "$index_file" ]]; then
        jq -r --arg bucket "$bucket_name" '.[$bucket] // "not_found"' "$index_file"
    else
        echo "index_not_found"
    fi
}

# Query trust relationships for multiple principals at once
bulk_trust_query() {
    local base_path="$1"
    local principals_file="$2"  # File containing one principal ARN per line
    local output_file="${3:-trust_relationships.json}"
    local index_file="$base_path/indexes/principals-to-trust-policies.json"

    if [[ ! -f "$index_file" ]]; then
        echo "Error: Index file not found: $index_file" >&2
        return 1
    fi

    if [[ ! -f "$principals_file" ]]; then
        echo "Error: Principals file not found: $principals_file" >&2
        return 1
    fi

    echo "[]" > "$output_file"

    while IFS= read -r principal; do
        if [[ -n "$principal" ]]; then
            roles=$(jq -r --arg principal "$principal" '
                [.[] | to_entries[] | .value | to_entries[] | select(.key == $principal) | .value] |
                flatten |
                unique
            ' "$index_file")

            if [[ "$roles" != "[]" && "$roles" != "null" ]]; then
                result=$(jq -n --arg principal "$principal" --argjson roles "$roles" '{
                    "principal": $principal,
                    "trusted_by_roles": $roles
                }')

                temp_file=$(mktemp)
                jq --argjson result "$result" '. + [$result]' "$output_file" > "$temp_file" && mv "$temp_file" "$output_file"
            fi
        fi
    done < "$principals_file"

    echo "Bulk trust query results saved to $output_file"
}

# Usage examples:
# get_organization_for_account "/path/to/iam-data" "123456789012"
# get_roles_trusting_principal "/path/to/iam-data" "arn:aws:iam::123456789012:user/example"
# get_account_for_bucket "/path/to/iam-data" "my-bucket-name"
# echo -e "arn:aws:iam::123:user/user1\narn:aws:iam::456:user/user2" > principals.txt
# bulk_trust_query "/path/to/iam-data" "principals.txt" "results.json"
```

## Best Practices for AI Analysis

### 1. Performance Optimization

- **Use indexes first**: Check `indexes/` directory before scanning filesystem
- **Filter early**: Use glob patterns to limit file scanning
- **Cache results**: Load frequently accessed data once
- **Parallel processing**: Process accounts or services in parallel when possible

### 2. Error Handling

- **Missing files**: Not all resources have all file types (e.g., not all roles have inline policies)
- **Empty policies**: Policy files may be empty or contain `null`
- **Encoding issues**: Resource names are URL-encoded in paths
- **Case sensitivity**: All paths are lowercase

### 3. Data Validation

- **JSON parsing**: Always handle JSON parsing errors gracefully
- **Schema validation**: Policy documents follow AWS IAM policy schema
- **Cross-references**: Verify ARNs match between metadata and policy files

### 4. Common Utilities

```python
import json
import os
import urllib.parse
from glob import glob

def extract_account_from_path(file_path):
    """Extract account ID from filesystem path."""
    parts = file_path.split('/')
    accounts_index = parts.index('accounts')
    return parts[accounts_index + 1]

def decode_resource_id(encoded_id):
    """Decode URL-encoded resource identifier."""
    return urllib.parse.unquote(encoded_id)

def load_json_safely(file_path):
    """Load JSON file with error handling."""
    try:
        with open(file_path, 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
                return None
```

**Bash/Shell Utility Functions**:

```bash
#!/bin/bash

# Extract account ID from filesystem path
extract_account_from_path() {
    local file_path="$1"
    echo "$file_path" | grep -o '/accounts/[^/]*' | cut -d'/' -f3
}

# Decode URL-encoded resource identifier
decode_resource_id() {
    local encoded_id="$1"
    python3 -c "import urllib.parse; print(urllib.parse.unquote('$encoded_id'))"
}

# Alternative using printf for systems without Python
decode_resource_id_pure_bash() {
    local encoded_id="$1"
    # Basic URL decoding for common cases
    echo "$encoded_id" | sed 's/%20/ /g; s/%2F/\//g; s/%3A/:/g; s/%40/@/g'
}

# Load JSON file with error handling
load_json_safely() {
    local file_path="$1"
    if [[ -f "$file_path" ]]; then
        if jq . "$file_path" >/dev/null 2>&1; then
            jq . "$file_path"
        else
            echo "null"
        fi
    else
        echo "null"
    fi
}

# Check if file exists and is valid JSON
is_valid_json_file() {
    local file_path="$1"
    [[ -f "$file_path" ]] && jq . "$file_path" >/dev/null 2>&1
}

# Extract ARN from metadata file
get_arn_from_metadata() {
    local metadata_file="$1"
    if is_valid_json_file "$metadata_file"; then
        jq -r '.arn // empty' "$metadata_file"
    fi
}

# Get resource name from metadata (tries multiple fields)
get_resource_name() {
    local metadata_file="$1"
    if is_valid_json_file "$metadata_file"; then
        jq -r '.name // .roleName // .userName // .groupName // .policyName // .id // empty' "$metadata_file"
    fi
}

# Convert ARN to filesystem path
arn_to_path() {
    local base_path="$1"
    local arn="$2"

    # Parse ARN components: arn:partition:service:region:account:resource
    IFS=':' read -ra ARN_PARTS <<< "$arn"

    if [[ ${#ARN_PARTS[@]} -ge 6 ]]; then
        local service="${ARN_PARTS[2]}"
        local region="${ARN_PARTS[3]}"
        local account="${ARN_PARTS[4]}"
        local resource="${ARN_PARTS[5]}"

        # Handle different resource formats
        if [[ "$resource" == *"/"* ]]; then
            IFS='/' read -ra RESOURCE_PARTS <<< "$resource"
            local resource_type="${RESOURCE_PARTS[0]}"
            local resource_name="${RESOURCE_PARTS[1]}"
        else
            local resource_type=""
            local resource_name="$resource"
        fi

        # URL encode the resource name
        local encoded_name
        encoded_name=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$resource_name'.lower()))" 2>/dev/null)
        [[ -z "$encoded_name" ]] && encoded_name="$resource_name"

        # Build path
        local path="$base_path/accounts/$account/$service"
        [[ -n "$region" ]] && path="$path/$region"
        [[ -n "$resource_type" ]] && path="$path/$resource_type"
        path="$path/$encoded_name"

        echo "$path"
    fi
}

# Find all policy files for a resource
find_resource_policies() {
    local resource_dir="$1"

    if [[ -d "$resource_dir" ]]; then
        find "$resource_dir" -name "*.json" -type f | while read -r file; do
            basename "$file"
        done | sort
    fi
}

# Check if a resource has specific policy types
has_policy_type() {
    local resource_dir="$1"
    local policy_type="$2"  # e.g., "trust-policy", "inline-policies", "policy"

    [[ -f "$resource_dir/$policy_type.json" ]]
}

# Quick security check functions
has_wildcard_principal() {
    local trust_policy_file="$1"
    if is_valid_json_file "$trust_policy_file"; then
        jq -e '.Statement[]? | select(.Principal == "*" or (.Principal | type == "object" and (. | tostring | contains("*"))))' "$trust_policy_file" >/dev/null 2>&1
    else
        return 1
    fi
}

has_wildcard_resource() {
    local policy_file="$1"
    if is_valid_json_file "$policy_file"; then
        jq -e '.Statement[]? | select(.Resource == "*" or (.Resource | type == "array" and . | contains(["*"])))' "$policy_file" >/dev/null 2>&1
    else
        return 1
    fi
}

# Usage examples:
# extract_account_from_path "/path/to/iam-data/accounts/123456789012/iam/role/example"
# decode_resource_id "my%2Drole%2Dname"
# load_json_safely "/path/to/metadata.json"
# arn_to_path "/path/to/iam-data" "arn:aws:iam::123456789012:role/MyRole"
# has_wildcard_principal "/path/to/trust-policy.json"
```

## Troubleshooting Common Issues

```python
def find_all_accounts(base_path):
"""Get list of all account IDs."""
account_dirs = glob(f"{base_path}/accounts/\*/")
return [os.path.basename(path.rstrip('/')) for path in account_dirs]
```

## Example Queries

### Query 1: Find all roles that can be assumed by any principal

```python
def find_publicly_assumable_roles(base_path):
    public_roles = []

    for trust_file in glob(f"{base_path}/accounts/*/iam/role/*/trust-policy.json"):
        trust_policy = load_json_safely(trust_file)
        if not trust_policy:
            continue

        for statement in trust_policy.get("Statement", []):
            if statement.get("Effect") == "Allow":
                principal = statement.get("Principal")
                if principal == "*":
                    role_dir = os.path.dirname(trust_file)
                    metadata = load_json_safely(f"{role_dir}/metadata.json")
                    if metadata:
                        public_roles.append(metadata)

    return public_roles
```

### Query 2: Find all S3 buckets with public read access

```python
def find_public_s3_buckets(base_path):
    public_buckets = []

    for policy_file in glob(f"{base_path}/accounts/*/s3/*/policy.json"):
        bucket_policy = load_json_safely(policy_file)
        if not bucket_policy:
            continue

        for statement in bucket_policy.get("Statement", []):
            if (statement.get("Effect") == "Allow" and
                statement.get("Principal") == "*" and
                any("s3:GetObject" in action for action in statement.get("Action", []))):

                bucket_dir = os.path.dirname(policy_file)
                metadata = load_json_safely(f"{bucket_dir}/metadata.json")
                if metadata:
                    public_buckets.append({
                        "bucket": metadata,
                        "policy_statement": statement
                    })

    return public_buckets
```

### Query 3: Find all cross-account RAM shares

```python
def find_cross_account_ram_shares(base_path):
    ram_shares = []

    for ram_file in glob(f"{base_path}/accounts/*/ram/*/*.json"):
        ram_data = load_json_safely(ram_file)
        if not ram_data:
            continue

        account_id = extract_account_from_path(ram_file)

        # Check if share is with external accounts
        for share in ram_data.get("resourceShares", []):
            for associated_entity in share.get("associatedEntities", []):
                if associated_entity != account_id:
                    ram_shares.append({
                        "sharing_account": account_id,
                        "receiving_entity": associated_entity,
                        "resource_arn": os.path.basename(ram_file).replace('.json', '').replace('-', ':'),
                        "share_details": share
                    })

    return ram_shares
```

This comprehensive guide provides AI systems with the knowledge needed to effectively analyze iam-collect data for security assessments, compliance auditing, and IAM policy optimization.
