const AWS = require("aws-sdk"),
    { v4: uuid } = require("uuid");

AWS.config.update({
    accessKeyId: process.env.AWS_KEY,
    secretAccessKey: process.env.AWS_SECRET,
});

const ddb = new AWS.DynamoDB(),
    eb = new AWS.EventBridge(),
    lambda = new AWS.Lambda();

/**
 *  Test Create - requires project_id
 * 	returns project object
 */
module.exports.create = async (data) => {
    return new Promise((resolve, reject) => {
        // assign default values
        Object.assign(data, {
            entity: "test",
            id: uuid(),
            name: data.name || "Unnamed test",
            type: data.type || "basic",
            project_id: data.project_id || null,
            created_at: Math.floor(+new Date() / 1000),
            trigger: data.trigger || "manual",
            runs_count: 0,
        });

        if (!data.project_id) {
            reject("project_id is required");
        }

        console.log(data);

        // write to DB
        ddb.putItem({
            TableName: process.env.DDB_TABLE,
            Item: AWS.DynamoDB.Converter.marshall(data),
        })
            .promise()
            .then(() => {
                // create the event rule for scheduled tests
                if (data.trigger === "scheduled" && data.schedule) {
                    return createEventRule(data);
                } else {
                    // just return an empty promise
                    return Promise.resolve(false);
                }
            })
            .then((res) => resolve(data))
            .catch((err) => {
                console.log(err);
                reject(err.message);
            });
    });
};

/**
 * 	Test Get
 * 	retrieve the project data from DB
 */

module.exports.get = async (id) => {
    return new Promise((resolve, reject) => {
        ddb.getItem({
            TableName: process.env.DDB_TABLE,
            Key: AWS.DynamoDB.Converter.marshall({
                entity: "test",
                id: id,
            }),
        })
            .promise()
            .then((res) => {
                if (res.Item) {
                    let item = AWS.DynamoDB.Converter.unmarshall(res.Item);
                    resolve(item);
                }

                // reject if no project was found
                reject("Test not found.");
            })
            .catch((err) => reject(err.message));
    });
};

/**
 * Test delete
 * requires test object
 * returns true or error
 */

module.exports.delete = async (item) => {
    return new Promise((resolve, reject) => {
        ddb.deleteItem({
            TableName: process.env.DDB_TABLE,
            Key: AWS.DynamoDB.Converter.marshall({
                entity: "test",
                id: item.id,
            }),
        })
            .promise()
            .then(() => {
                // delete the event rule / needs to be reviewed
                return removeEventRule(item);
            })
            .then(() => resolve(true))
            .catch((err) => reject(err.message));
    });
};

/**
 *  Creates EventBridge rule for scheduled runs
 */
const createEventRule = async (data) =>
    new Promise((resolve, reject) => {
        eb.putRule({
            Name: process.env.RESOURCE_PREFIX + "_" + data.id,
            ScheduleExpression: data.schedule,
            State: "ENABLED",
        })
            .promise()
            .then((res) => {
                return lambda
                    .addPermission({
                        Action: "lambda:InvokeFunction",
                        FunctionName:
                            data.type === "basic"
                                ? process.env.LAMBDA_BASIC
                                : process.env.LAMBDA_BROWSER,
                        StatementId: "Lambda_" + data.type + "_" + data.id,
                        Principal: "events.amazonaws.com",
                        SourceArn: res.RuleArn,
                    })
                    .promise();
            })
            .then((res) => {
                return eb
                    .putTargets({
                        Rule: process.env.RESOURCE_PREFIX + "_" + data.id,
                        Targets: [
                            {
                                Id: "Lambda_" + data.type,
                                Arn:
                                    data.type === "basic"
                                        ? process.env.LAMBDA_BASIC
                                        : process.env.LAMBDA_BROWSER,
                                // pass test_id to the target
                                Input: JSON.stringify({
                                    test_id: data.id,
                                }),
                            },
                        ],
                    })
                    .promise();
            })
            .then(() => resolve())
            .catch((err) => reject(err));
    });

/**
 *  Removes the EventBridge rule (incl Targets)
 */
const removeEventRule = async (data) =>
    new Promise((resolve, reject) => {
        // get targets first
        eb.listTargetsByRule({
            Rule: process.env.RESOURCE_PREFIX + "_" + data.id,
        })
            .promise()
            .then((res) => {
                if (res.Targets && res.Targets.length) {
                    // delete targets
                    return eb
                        .removeTargets({
                            Ids: res.Targets.map((item) => item.Id),
                            Rule: process.env.RESOURCE_PREFIX + "_" + data.id,
                        })
                        .promise();
                } else {
                    // just resolve
                    return Promise.resolve(true);
                }
            })
            .then(() => {
                return lambda
                    .removePermission({
                        FunctionName:
                            data.type === "basic"
                                ? process.env.LAMBDA_BASIC
                                : process.env.LAMBDA_BROWSER,
                        StatementId: "Lambda_" + data.type + "_" + data.id,
                    })
                    .promise();
            })
            // delete the rule
            .then(() =>
                eb
                    .deleteRule({
                        Name: process.env.RESOURCE_PREFIX + "_" + data.id,
                    })
                    .promise()
            )
            .then(() => resolve())
            .catch((err) => {
                // resolve anyway
                console.log(err);
                resolve();
            });
    });