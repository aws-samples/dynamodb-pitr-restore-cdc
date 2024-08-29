/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify,
merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ddb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as eventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as data from "./state-machine.json";
import * as logs from "aws-cdk-lib/aws-logs";

import { Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";

export class PITRDynamoDBNoDowntimeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    let sourceTableParam = this.node.tryGetContext("table-name");
    sourceTableParam = sourceTableParam.replace(/[^A-Za-z0-9-]/g, "-");

    const sourceTableStreamsParam =
      this.node.tryGetContext("table-streams-arn");

    const bufferQueue = new sqs.Queue(
      this,
      "cdc-buffer-queue-" + sourceTableParam + ".fifo",
      {
        fifo: true,
        contentBasedDeduplication: true,
        encryption: sqs.QueueEncryption.KMS_MANAGED,
        enforceSSL: true,
        queueName: "buffer-cdc-dynamodb-iac-" + sourceTableParam + ".fifo",
        deadLetterQueue: {
          maxReceiveCount: 5, // Number of times a message can be received before being moved to the DLQ
          queue: new sqs.Queue(
            this,
            "buffer-cdc-dynamodb-iac-dlq-" + sourceTableParam,
            {
              queueName: "buffer-cdc-dynamodb-iac-dlq-" + sourceTableParam,
              encryption: sqs.QueueEncryption.KMS_MANAGED,
              enforceSSL: true,
            }
          ),
        },
      }
    );
    const cdcToSqsLambda = this.buildCdctoSqsLambda(
      props,
      bufferQueue,
      sourceTableParam
    );

    const checkDdbStatus = this.buildCheckDdbStatusLambda(
      props,
      sourceTableParam
    );

    const lambdaBackfill = this.buildLambdaBackfill(
      props,
      bufferQueue,
      sourceTableParam
    );

    const initiateLambdaBackfillFunction =
      this.buildInitiateLambdaBackfillLambda(
        props,
        lambdaBackfill,
        bufferQueue,
        sourceTableParam
      );

    const sourceTable = ddb.Table.fromTableAttributes(this, "mytable", {
      tableName: sourceTableParam,
      tableStreamArn: sourceTableStreamsParam,
    });

    cdcToSqsLambda.addEventSource(
      new eventSources.DynamoEventSource(sourceTable, {
        startingPosition: lambda.StartingPosition.LATEST,
      })
    );

    const EBExecutionRole = new iam.Role(this, "EBExecutionRole", {
      assumedBy: new iam.ServicePrincipal("events.amazonaws.com"),
    });

    const stateMachine = this.buildStepFunction(
      checkDdbStatus,
      initiateLambdaBackfillFunction,
      sourceTableParam
    );

    const rule = new events.Rule(this, "eventbridge-rule-restore-triggered", {
      ruleName: "ddb-pitr-triggered-iac-" + sourceTableParam,
      description: "This rule will be actively listening to Retore PITR Events",
      enabled: true,
      eventPattern: {
        detail: {
          eventSource: ["dynamodb.amazonaws.com"],
          eventName: ["RestoreTableToPointInTime"],
        },
        detailType: ["AWS API Call via CloudTrail"],
        source: ["aws.dynamodb"],
      },
    });
    rule.addTarget(
      new targets.SfnStateMachine(stateMachine, {
        role: EBExecutionRole,
      })
    );
  }

  private buildStepFunction(
    checkDdbStatus: cdk.aws_lambda.Function,
    initiateLambdaBackfillFunction: cdk.aws_lambda.Function,
    sourceTableParam: string
  ) {
    const step = data;
    step.States[
      "Poll Restore table status"
    ].Parameters.FunctionName = `${checkDdbStatus.functionArn}:$LATEST`;
    step.States[
      "Hook Lambda into SQS and Backfill"
    ].Parameters.FunctionName = `${initiateLambdaBackfillFunction.functionArn}:$LATEST`;

    const sfExecutionRole = new iam.Role(this, "step-function-execution-role", {
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
    });
    sfExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: [
          `${initiateLambdaBackfillFunction.functionArn}:*`,
          `${checkDdbStatus.functionArn}:*`,
        ],
      })
    );
    sfExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets",
        ],
        resources: ["*"],
      })
    );

    const stateMachine = new sfn.StateMachine(
      this,
      "stateMachinePITRRestore" + sourceTableParam,
      {
        stateMachineName: "state-machine-pitr-iac-" + sourceTableParam,
        stateMachineType: sfn.StateMachineType.STANDARD,
        definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(step)),
        role: sfExecutionRole,
        tracingEnabled: true,
        logs: {
          destination: new logs.LogGroup(
            this,
            "state-machine-pitr-iac-log-group-" + sourceTableParam
          ),
          level: sfn.LogLevel.ALL,
        },
      }
    );
    return stateMachine;
  }

  private buildCdctoSqsLambda(
    props: cdk.StackProps | undefined,
    bufferQueue: sqs.Queue,
    sourceTableParam: string
  ): lambda.Function {
    const cdcToSqsRole = new iam.Role(
      this,
      "cdcToSqsRole-" + sourceTableParam,
      {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        roleName: "cdcToSqsRole" + sourceTableParam,
      }
    );
    cdcToSqsRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: [
          `arn:aws:lambda:${props?.env?.region}:${props?.env?.account}:function:cdc-to-sqs-iac`,
        ],
      })
    );
    cdcToSqsRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:CreateLogGroup"],
        resources: [
          `arn:aws:logs:${props?.env?.region}:${props?.env?.account}:*`,
        ],
      })
    );
    cdcToSqsRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          `arn:aws:logs:${props?.env?.region}:${props?.env?.account}:log-group:/aws/lambda/cdc-to-sqs-iac:*`,
        ],
      })
    );
    cdcToSqsRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:SendMessage",
        ],
        resources: [bufferQueue.queueArn],
      })
    );

    return new lambda.Function(this, "cdc-to-sqs-iac-" + sourceTableParam, {
      runtime: lambda.Runtime.PYTHON_3_12, // execution environment
      code: lambda.Code.fromAsset("../app/lambdas/cdc-to-sqs/"), // code loaded from "lambda" directory
      handler: "main.lambda_handler",
      role: cdcToSqsRole,
      functionName: "cdc-to-sqs-iac-" + sourceTableParam,
      environment: {
        SQS_QUEUE_URL: bufferQueue.queueUrl,
      },
    });
  }

  private buildCheckDdbStatusLambda(
    props: cdk.StackProps | undefined,
    sourceTableParam: string
  ): lambda.Function {
    const checkDdbStatusRole = new iam.Role(
      this,
      "check-ddb-status-role-" + sourceTableParam,
      {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        roleName: "check-ddb-status-role-" + sourceTableParam,
      }
    );
    checkDdbStatusRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: ["*"],
      })
    );
    checkDdbStatusRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:CreateLogGroup"],
        resources: [
          `arn:aws:logs:${props?.env?.region}:${props?.env?.account}:*`,
        ],
      })
    );
    checkDdbStatusRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          `arn:aws:logs:${props?.env?.region}:${props?.env?.account}:log-group:/aws/lambda/check-ddb-status-iac-${sourceTableParam}:*`,
        ],
      })
    );
    checkDdbStatusRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:DescribeTable"],
        resources: ["*"],
      })
    );

    return new lambda.Function(
      this,
      "check-ddb-status-fn-" + sourceTableParam,
      {
        runtime: lambda.Runtime.PYTHON_3_12, // execution environment
        code: lambda.Code.fromAsset("../app/lambdas/check-ddb-status/"), // code loaded from "lambda" directory
        handler: "main.lambda_handler",
        role: checkDdbStatusRole,
        functionName: "check-ddb-status-iac-" + sourceTableParam,
      }
    );
  }

  private buildInitiateLambdaBackfillLambda(
    props: cdk.StackProps | undefined,
    lambdaFn: lambda.Function,
    bufferQueue: sqs.Queue,
    sourceTableParam: string
  ): lambda.Function {
    const initiateLambdaBackfillRole = new iam.Role(
      this,
      "initiate-lambda-backfill-role",
      {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        roleName: "initiate-lambda-backfill-role-" + sourceTableParam,
      }
    );
    initiateLambdaBackfillRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: ["*"],
      })
    );
    initiateLambdaBackfillRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: [
          `arn:aws:logs:${props?.env?.region}:${props?.env?.account}:*`,
        ],
      })
    );
    initiateLambdaBackfillRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["lambda:UpdateFunctionConfiguration"],
        resources: [lambdaFn.functionArn],
      })
    );
    initiateLambdaBackfillRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "lambda:CreateEventSourceMapping",
          "lambda:UpdateEventSourceMapping",
          "lambda:ListEventSourceMappings",
        ],
        resources: ["*"],
      })
    );
    initiateLambdaBackfillRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["kms:Decrypt", "kms:Encrypt"],
        resources: [
          `arn:aws:kms:${props?.env?.region}:${props?.env?.account}:key/*`,
        ],
      })
    );

    return new lambda.Function(
      this,
      "initiate-lambda-backfill-fn-" + sourceTableParam,
      {
        runtime: lambda.Runtime.PYTHON_3_12, // execution environment
        code: lambda.Code.fromAsset("../app/lambdas/initiate-lambda-backfill/"), // code loaded from "lambda" directory
        handler: "main.lambda_handler",
        role: initiateLambdaBackfillRole,
        functionName: "initiate-lambda-backfill-iac-" + sourceTableParam,
        environment: {
          sqs_arn: bufferQueue.queueArn,
          lambda_function_name: lambdaFn.functionName,
        },
      }
    );
  }

  private buildLambdaBackfill(
    props: cdk.StackProps | undefined,
    bufferQueue: sqs.Queue,
    sourceTableParam: string
  ): lambda.Function {
    const buildLambdaBackfill = new iam.Role(
      this,
      "lambda-backfill-role-" + sourceTableParam,
      {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        roleName: "lambda-backfill-role-" + sourceTableParam,
      }
    );
    buildLambdaBackfill.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: ["*"],
      })
    );
    buildLambdaBackfill.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:CreateLogGroup"],
        resources: [
          `arn:aws:logs:${props?.env?.region}:${props?.env?.account}:*`,
        ],
      })
    );
    buildLambdaBackfill.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          `arn:aws:logs:${props?.env?.region}:${props?.env?.account}:log-group:/aws/lambda/lambda-backfill-iac-${sourceTableParam}:*`,
        ],
      })
    );
    buildLambdaBackfill.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
        ],
        resources: [bufferQueue.queueArn],
      })
    );
    buildLambdaBackfill.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "dynamodb:PutItem",
          "dynamodb:BatchWriteItem",
          "dynamodb:GetItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
        ],
        resources: ["*"],
      })
    );

    return new lambda.Function(this, "lambda-backfill-" + sourceTableParam, {
      runtime: lambda.Runtime.PYTHON_3_12, // execution environment
      code: lambda.Code.fromAsset("../app/lambdas/lambda-backfill/"), // code loaded from "lambda" directory
      handler: "main.lambda_handler",
      role: buildLambdaBackfill,
      functionName: "lambda-backfill-iac-" + sourceTableParam,
    });
  }
}
