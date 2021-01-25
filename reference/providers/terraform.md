---
title: '`terraform` Provider'
tocTitle: '`terraform`'
---

# terraform

## Description

This provider allows you to integrate Terraform stacks into your Garden project. See the [Terraform guide](https://docs.garden.io/advanced/terraform) for details and usage information.

Below is the full schema reference for the provider configuration. For an introduction to configuring a Garden project with providers, please look at our [configuration guide](../../using-garden/configuration-overview.md).

The reference is divided into two sections. The [first section](terraform.md#complete-yaml-schema) contains the complete YAML schema, and the [second section](terraform.md#configuration-keys) describes each schema key.

## Complete YAML Schema

The values in the schema below are the default values.

```yaml
providers:
  - # The name of the provider plugin to use.
    name:

    # List other providers that should be resolved before this one.
    dependencies: []

    # If specified, this provider will only be used in the listed environments. Note that an empty array effectively
    # disables the provider. To use a provider in all environments, omit this field.
    environments:

    # If set to true, Garden will run `terraform destroy` on the project root stack when calling `garden delete env`.
    allowDestroy: false

    # If set to true, Garden will automatically run `terraform apply -auto-approve` when a stack is not up-to-date.
    # Otherwise, a warning is logged if the stack is out-of-date, and an error thrown if it is missing entirely.
    #
    # **Note: This is not recommended for production, or shared environments in general!**
    autoApply: false

    # Specify the path to a Terraform config directory, that should be resolved when initializing the provider. This
    # is useful when other providers need to be able to reference the outputs from the stack.
    #
    # See the [Terraform guide](https://docs.garden.io/advanced/terraform) for more information.
    initRoot:

    # A map of variables to use when applying Terraform stacks. You can define these here, in individual
    # `terraform` module configs, or you can place a `terraform.tfvars` file in each working directory.
    variables:

    # The version of Terraform to use.
    version: 0.12.26
```

## Configuration Keys

### `providers[]`

| Type | Default | Required |
| :--- | :--- | :--- |
| `array[object]` | `[]` | No |

### `providers[].name`

[providers](terraform.md#providers) &gt; name

The name of the provider plugin to use.

| Type | Required |
| :--- | :--- |
| `string` | Yes |

Example:

```yaml
providers:
  - name: "local-kubernetes"
```

### `providers[].dependencies[]`

[providers](terraform.md#providers) &gt; dependencies

List other providers that should be resolved before this one.

| Type | Default | Required |
| :--- | :--- | :--- |
| `array[string]` | `[]` | No |

Example:

```yaml
providers:
  - dependencies:
      - exec
```

### `providers[].environments[]`

[providers](terraform.md#providers) &gt; environments

If specified, this provider will only be used in the listed environments. Note that an empty array effectively disables the provider. To use a provider in all environments, omit this field.

| Type | Required |
| :--- | :--- |
| `array[string]` | No |

Example:

```yaml
providers:
  - environments:
      - dev
      - stage
```

### `providers[].allowDestroy`

[providers](terraform.md#providers) &gt; allowDestroy

If set to true, Garden will run `terraform destroy` on the project root stack when calling `garden delete env`.

| Type | Default | Required |
| :--- | :--- | :--- |
| `boolean` | `false` | No |

### `providers[].autoApply`

[providers](terraform.md#providers) &gt; autoApply

If set to true, Garden will automatically run `terraform apply -auto-approve` when a stack is not up-to-date. Otherwise, a warning is logged if the stack is out-of-date, and an error thrown if it is missing entirely.

**Note: This is not recommended for production, or shared environments in general!**

| Type | Default | Required |
| :--- | :--- | :--- |
| `boolean` | `false` | No |

### `providers[].initRoot`

[providers](terraform.md#providers) &gt; initRoot

Specify the path to a Terraform config directory, that should be resolved when initializing the provider. This is useful when other providers need to be able to reference the outputs from the stack.

See the [Terraform guide](https://docs.garden.io/advanced/terraform) for more information.

| Type | Required |
| :--- | :--- |
| `posixPath` | No |

### `providers[].variables`

[providers](terraform.md#providers) &gt; variables

A map of variables to use when applying Terraform stacks. You can define these here, in individual `terraform` module configs, or you can place a `terraform.tfvars` file in each working directory.

| Type | Required |
| :--- | :--- |
| `object` | No |

### `providers[].version`

[providers](terraform.md#providers) &gt; version

The version of Terraform to use.

| Type | Default | Required |
| :--- | :--- | :--- |
| `string` | `"0.12.26"` | No |
