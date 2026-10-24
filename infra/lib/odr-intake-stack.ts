import path from 'node:path';
import fs from 'node:fs';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Serverless POC stack:
 *   CloudFront ─┬─ /*      → S3 (React app)
 *               └─ /api/*  → API Gateway HTTP API → Lambda (validation API)
 *   Lambda → DynamoDB (config + history), S3 (uploads + reports)
 *   Browser → Cognito (sign-in), S3 presigned PUT (upload)
 *
 * POC settings: resources are destroyed with the stack. Change RemovalPolicy for anything longer-lived.
 */
export class OdrIntakeStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---------- Data ----------
    const table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      encryption: dynamodb.TableEncryptionV2.awsManagedKey(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const filesBucket = new s3.Bucket(this, 'FilesBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: false,
      // Browsers upload/download directly with short-lived presigned URLs.
      cors: [{ allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET], allowedOrigins: ['*'], allowedHeaders: ['content-type'], maxAge: 3000 }],
      lifecycleRules: [{ prefix: 'uploads/', expiration: Duration.days(90) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---------- Auth ----------
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false, // administrators invite users
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: true }, fullname: { required: false, mutable: true } },
      customAttributes: { orgId: new cognito.StringAttribute({ mutable: true, maxLen: 32 }) },
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const client = userPool.addClient('WebClient', {
      authFlows: { userPassword: true, userSrp: true },
      generateSecret: false,
      idTokenValidity: Duration.hours(8),
      accessTokenValidity: Duration.hours(8),
      preventUserExistenceErrors: true,
      readAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true, fullname: true }).withCustomAttributes('orgId'),
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ fullname: true }),
    });
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', { userPoolId: userPool.userPoolId, groupName: 'admin', description: 'Rule administrators' });

    // ---------- API ----------
    const fn = new NodejsFunction(this, 'ApiFunction', {
      entry: path.join(ROOT, 'packages/api/src/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.seconds(29),
      depsLockFilePath: path.join(ROOT, 'package-lock.json'),
      projectRoot: ROOT,
      bundling: { format: OutputFormat.CJS, minify: true, sourceMap: true, target: 'node24', externalModules: ['@aws-sdk/*'] },
      environment: {
        APP_MODE: 'aws',
        NODE_OPTIONS: '--enable-source-maps',
        TABLE_NAME: table.tableName,
        BUCKET_NAME: filesBucket.bucketName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: client.userPoolClientId,
        COGNITO_ADMIN_GROUP: 'admin',
      },
      logGroup: new logs.LogGroup(this, 'ApiLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
    });
    table.grantReadWriteData(fn);
    filesBucket.grantReadWrite(fn);

    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', fn),
      description: 'File Intake validation API',
    });

    // ---------- Web ----------
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Serve index.html for client-side routes (paths without a file extension).
    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event){var r=event.request;if(!r.uri.includes('.')){r.uri='/index.html';}return r;}",
      ),
    });

    const apiDomain = `${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`;
    const distribution = new cloudfront.Distribution(this, 'Web', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(apiDomain, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });

    const webDist = path.join(ROOT, 'packages/web/dist');
    if (fs.existsSync(path.join(webDist, 'index.html'))) {
      new s3deploy.BucketDeployment(this, 'DeployWeb', {
        sources: [s3deploy.Source.asset(webDist)],
        destinationBucket: webBucket,
        distribution,
        distributionPaths: ['/*'],
      });
    }

    new CfnOutput(this, 'AppUrl', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'FilesBucketName', { value: filesBucket.bucketName });
  }
}
