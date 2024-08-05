"""
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
"""


import os
import boto3
from botocore.exceptions import ClientError


EVENT_SOURCE_ARN = os.environ["sqs_arn"]
FUNCTION_NAME = os.environ["lambda_function_name"]

BATCH_SIZE = 1000
MAXIMUM_BATCHING_WINDOW_IN_SECONDS = 5

lambda_client = boto3.client("lambda")

def create_or_update_event_source_mapping():
    try:
        existing_mappings = lambda_client.list_event_source_mappings(
            EventSourceArn=EVENT_SOURCE_ARN,
            FunctionName=FUNCTION_NAME
        )
        print(f"Existing event source mappings: {existing_mappings}")
        if existing_mappings['EventSourceMappings']:
            mapping_id = existing_mappings['EventSourceMappings'][0]['UUID']
            response = lambda_client.update_event_source_mapping(
                UUID=mapping_id,
                Enabled=True,
                BatchSize=BATCH_SIZE,
                MaximumBatchingWindowInSeconds=MAXIMUM_BATCHING_WINDOW_IN_SECONDS
            )
            print(f"Updated event source mapping: {response['UUID']}")
            print(response)
        else:
            response = lambda_client.create_event_source_mapping(
                EventSourceArn=EVENT_SOURCE_ARN,
                FunctionName=FUNCTION_NAME,
                Enabled=True,
                BatchSize=BATCH_SIZE,
                MaximumBatchingWindowInSeconds=MAXIMUM_BATCHING_WINDOW_IN_SECONDS
            )
            print(f"Created new event source mapping: {response['UUID']}")
            print(response)
    except ClientError as e:
        print(f"Error: {e}")


def lambda_handler(event, context):
    print(event["detail"])

    result = lambda_client.update_function_configuration(
        FunctionName=FUNCTION_NAME,
        Environment={
            "Variables": {
                "destination_table": event["detail"]["requestParameters"][
                    "targetTableName"
                ]
            }
        },
    )
    print(f"Update function configuration: {result}")

    create_or_update_event_source_mapping()
