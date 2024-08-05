#!/usr/bin/env node
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

import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import { Aspects } from "aws-cdk-lib";

import { PITRDynamoDBNoDowntimeStack } from "../lib/cdk-stack";

const app = new cdk.App();
let tableName = app.node.tryGetContext("table-name");
let tableStreams = app.node.tryGetContext("table-streams-arn");

if (!tableName) {
  throw new Error(
    'Context parameter "table-name" is required. Use -c table-name=<your-table-name>'
  );
}
if (!tableStreams) {
  throw new Error(
    'Context parameter "table-streams-arn" is required. Use -c table-streams-arn=<your-table-streams-arn>'
  );
}

tableName = tableName.replace(/^[^A-Za-z]+/, "");
tableName = tableName.replace(/[^A-Za-z0-9-]/g, "-");

// Validate the table name against the regex
const regex = /^[A-Za-z][A-Za-z0-9-]*$/;
if (!regex.test(tableName)) {
  throw new Error(
    "Sanitized table name does not match the required pattern /^[A-Za-z][A-Za-z0-9-]*$/"
  );
}

const myStack = new PITRDynamoDBNoDowntimeStack(
  app,
  `PITRDynamoDBNoDowntimeStack-${tableName}`,
  {
    // synthesizer: new cdk.DefaultStackSynthesizer({
    //   qualifier: 'final',
    // }),
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
  }
);

const accountId = cdk.Stack.of(myStack).account;
const region = cdk.Stack.of(myStack).region;

// Add the AwsSolutionsChecks NagPack
const awsSolutionsChecks = new AwsSolutionsChecks({ verbose: true });
Aspects.of(myStack).add(awsSolutionsChecks);

NagSuppressions.addResourceSuppressions(
  myStack,
  [
    {
      id: "AwsSolutions-IAM5",
      reason: "The wildcard is to ensure access to all lambda logs.",
    },
  ],
  true
);
