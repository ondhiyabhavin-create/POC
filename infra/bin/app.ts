import { App } from 'aws-cdk-lib';
import { OdrIntakeStack } from '../lib/odr-intake-stack';

const app = new App();
new OdrIntakeStack(app, process.env.STACK_NAME ?? 'FileIntakePoc', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
  description: 'File Intake pre-submission validation POC (synthetic data only)',
});
