const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

admin.initializeApp();

// Configure nodemailer with your email service (e.g., Gmail)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

// Helper function to send email
async function sendEmail(to, subject, html) {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to,
        subject,
        html
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('Email sent successfully to:', to);
    } catch (error) {
        console.error('Error sending email:', error);
        throw error;
    }
}

// Function to send room creation notification
exports.onRoomCreated = functions.firestore
    .document('rooms/{roomId}')
    .onCreate(async (snap, context) => {
        const roomData = snap.data();
        const roomId = context.params.roomId;

        // Get all members except the creator
        const members = roomData.members.filter(member => member.id !== roomData.createdBy);

        // Email template for room creation
        const emailTemplate = `
      <h2>Welcome to ${roomData.name}!</h2>
      <p>You have been added to a new room in CloudSync.</p>
      <p><strong>Room Details:</strong></p>
      <ul>
        <li>Name: ${roomData.name}</li>
        <li>Description: ${roomData.description || 'No description'}</li>
        <li>Created by: ${roomData.members.find(m => m.id === roomData.createdBy).email}</li>
        <li>Your role: ${member => member.role}</li>
      </ul>
      <p>Click <a href="${process.env.APP_URL}/room.html?id=${roomId}">here</a> to access the room.</p>
    `;

        // Send email to each member
        const emailPromises = members.map(member =>
            sendEmail(
                member.email,
                `You've been added to ${roomData.name} on CloudSync`,
                emailTemplate.replace('${member => member.role}', member.role)
            )
        );

        await Promise.all(emailPromises);
    });

// Function to send room activity notification
exports.onRoomActivity = functions.firestore
    .document('rooms/{roomId}/activities/{activityId}')
    .onCreate(async (snap, context) => {
        const activityData = snap.data();
        const roomId = context.params.roomId;

        // Get room data
        const roomDoc = await admin.firestore().doc(`rooms/${roomId}`).get();
        const roomData = roomDoc.data();

        // Get all members except the activity performer
        const members = roomData.members.filter(member => member.email !== activityData.performedBy);

        // Get activity description
        const activityDescription = getActivityDescription(activityData);

        // Email template for activity notification
        const emailTemplate = `
      <h2>New Activity in ${roomData.name}</h2>
      <p>${activityDescription}</p>
      <p><strong>Details:</strong></p>
      <ul>
        <li>Room: ${roomData.name}</li>
        <li>Activity: ${activityDescription}</li>
        <li>Time: ${new Date(activityData.timestamp).toLocaleString()}</li>
      </ul>
      <p>Click <a href="${process.env.APP_URL}/room.html?id=${roomId}">here</a> to view the room.</p>
    `;

        // Send email to each member
        const emailPromises = members.map(member =>
            sendEmail(
                member.email,
                `New activity in ${roomData.name} on CloudSync`,
                emailTemplate
            )
        );

        await Promise.all(emailPromises);
    });

// Helper function to get activity description
function getActivityDescription(activity) {
    switch (activity.type) {
        case 'FILE_UPLOADED':
            return `${activity.performedBy} uploaded ${activity.fileName}`;
        case 'FILE_DOWNLOADED':
            return `${activity.performedBy} downloaded ${activity.fileName}`;
        case 'FILE_DELETED':
            return `${activity.performedBy} deleted ${activity.fileName}`;
        case 'FILE_SHARED':
            return `${activity.performedBy} shared ${activity.fileName}`;
        case 'MEMBER_INVITED':
            return `${activity.performedBy} invited ${activity.memberEmail}`;
        case 'MEMBER_REMOVED':
            return `${activity.performedBy} removed ${activity.memberEmail}`;
        case 'SETTINGS_UPDATED':
            return `${activity.performedBy} updated room settings`;
        case 'ROLE_CHANGE':
            return `${activity.performedBy} changed ${activity.memberEmail}'s role to ${activity.newRole}`;
        default:
            return 'Unknown activity';
    }
} 